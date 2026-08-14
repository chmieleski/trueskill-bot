import type { ActionRowBuilder, ButtonBuilder, Client, EmbedBuilder } from 'discord.js';
import { env } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import type { LobbyPlayer } from './lobby-ocr.js';
import {
  buildLobbyButtons,
  buildMatchCancelledEmbed,
  buildMatchCompletedEmbed,
  buildMatchInProgressEmbed,
  buildMatchLobbyEmbed,
  buildMatchReportButtons,
  canStartLobby,
} from './lobby-preview.js';
import {
  cancelMatch,
  findPendingMatchesByHost,
  getMatchByDiscordMessageId,
  getMatchById,
  linkMatchWc3statsGameId,
  matchToLobbyPlayers,
  MatchServiceError,
  replaceMatchRoster,
  startMatch,
  type MatchWithPlayers,
} from './match-service.js';
import {
  loadLobbyRatingPreview,
  matchPlayersToRatingEntries,
  type LobbyRatingPreview,
} from './rating-preview.js';
import { assertCanManageMatch } from './match-auth.js';
import { normalizeNick } from './player-nick.js';
import { resolveGuildConfig } from './guild-config.js';
import { nickForDiscordId } from './lobby-identity.js';
import {
  importWc3statsLobby,
  type ImportWc3statsLobbyResult,
} from './wc3stats-resolve.js';
import { applyWc3statsRefresh } from './wc3stats-roster.js';
import { loadGuildWc3statsHeroSlotMap } from './wc3stats-slot-map.js';

const log = createLogger('lobby-actions');

const MIN_SLOT = 1;
const MAX_SLOT = 12;

const OWNER_ONLY_MESSAGE = 'Only the user who registered this lobby can do that.';
const NOT_FOUND_MESSAGE = 'This match lobby was not found. Run /register_lobby again.';
const NOT_EDITABLE_MESSAGE = 'This match can no longer be edited.';
const NO_PENDING_MESSAGE = 'You have no pending match lobby. Run /register_lobby first.';
const AMBIGUOUS_PENDING_MESSAGE =
  'You have more than one pending lobby. Pass match_id to choose which one.';
const PLAYER_CLAIM_DISABLED_MESSAGE = 'Player slot claim is disabled on this server.';
const ALREADY_IN_LOBBY_LEAVE_FIRST = (slot: number) =>
  `You are already in slot ${slot}. Leave first.`;
const NOT_IN_LOBBY_MESSAGE = 'You are not in this lobby.';
const WC3STATS_NOT_LINKED_MESSAGE =
  'This lobby is not linked to a Warcraft game list entry.';
const WC3STATS_IMPORT_DISABLED_MESSAGE = 'Warcraft lobby import is disabled.';
const WC3STATS_REFRESH_WAIT_MESSAGE = 'Wait a few seconds before refreshing again.';
const WC3STATS_REFRESH_KEPT_MESSAGE =
  'wc3stats still has no player list. Your current roster was kept.';
const LOBBY_UPDATED_MESSAGE = 'Lobby updated.';
const REFRESH_DEBOUNCE_MS = 15_000;
const lastRefreshAtByMatchId = new Map<string, number>();

export type LobbySyncMode = 'pending' | 'started' | 'cancelled' | 'completed';

export interface LobbyActionResult {
  match: MatchWithPlayers;
  players: LobbyPlayer[];
}

export interface ResolveHostPendingMatchInput {
  hostDiscordId: string;
  matchId?: string | null;
}

function assertSlotInRange(slot: number): void {
  if (!Number.isInteger(slot) || slot < MIN_SLOT || slot > MAX_SLOT) {
    throw new MatchServiceError(
      `Invalid slot ${slot}. Slots must be between ${MIN_SLOT} and ${MAX_SLOT}.`,
    );
  }
}

function assertHostOwnsPending(match: MatchWithPlayers, hostDiscordId: string): void {
  if (match.hostDiscordId !== hostDiscordId) {
    throw new MatchServiceError(OWNER_ONLY_MESSAGE);
  }

  if (match.status !== 'PENDING') {
    throw new MatchServiceError(NOT_EDITABLE_MESSAGE);
  }
}

function determineWinningTeam(players: MatchWithPlayers['players']): 1 | 2 {
  return players.some((player) => player.result === 'WIN' && player.slot <= 6) ? 1 : 2;
}

/**
 * Resolve the host's PENDING match: explicit match_id, or the sole PENDING lobby.
 */
export async function resolveHostPendingMatch(
  input: ResolveHostPendingMatchInput,
): Promise<{ match: MatchWithPlayers; players: LobbyPlayer[] }> {
  const { hostDiscordId, matchId } = input;

  if (matchId) {
    const match = await getMatchById(matchId);

    if (!match) {
      throw new MatchServiceError(NOT_FOUND_MESSAGE);
    }

    assertHostOwnsPending(match, hostDiscordId);
    return { match, players: matchToLobbyPlayers(match) };
  }

  const pending = await findPendingMatchesByHost(hostDiscordId);

  if (pending.length === 0) {
    throw new MatchServiceError(NO_PENDING_MESSAGE);
  }

  if (pending.length > 1) {
    throw new MatchServiceError(AMBIGUOUS_PENDING_MESSAGE);
  }

  const match = pending[0]!;
  return { match, players: matchToLobbyPlayers(match) };
}

/**
 * Resolve a PENDING match from the Discord lobby message (button/modal path).
 * Any user may act — no host ownership check.
 */
export async function resolvePendingMatchByMessageId(input: {
  messageId: string;
}): Promise<{ match: MatchWithPlayers; players: LobbyPlayer[] }> {
  const match = await getMatchByDiscordMessageId(input.messageId);

  if (!match) {
    log.verbose({ messageId: input.messageId }, 'Match lobby missing for message');
    throw new MatchServiceError(NOT_FOUND_MESSAGE);
  }

  if (match.status !== 'PENDING') {
    log.warn(
      {
        messageId: input.messageId,
        matchId: match.id,
        status: match.status,
      },
      'Lobby not editable',
    );
    throw new MatchServiceError(NOT_EDITABLE_MESSAGE);
  }

  return { match, players: matchToLobbyPlayers(match) };
}

export async function resolveInProgressMatchByMessageId(input: {
  messageId: string;
  actorDiscordId: string;
  memberRoleIds: string[];
  matchModRoleId?: string;
}): Promise<MatchWithPlayers> {
  const match = await getMatchByDiscordMessageId(input.messageId);

  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }

  if (match.status !== 'IN_PROGRESS') {
    throw new MatchServiceError('This match is not in progress.');
  }

  assertCanManageMatch({
    hostDiscordId: match.hostDiscordId,
    actorDiscordId: input.actorDiscordId,
    memberRoleIds: input.memberRoleIds,
    matchModRoleId: input.matchModRoleId,
  });

  return match;
}

/** @deprecated Prefer resolvePendingMatchByMessageId — host check removed. */
export async function resolveHostPendingMatchByMessageId(input: {
  messageId: string;
  hostDiscordId: string;
}): Promise<{ match: MatchWithPlayers; players: LobbyPlayer[] }> {
  return resolvePendingMatchByMessageId({ messageId: input.messageId });
}

export function addPlayer(players: LobbyPlayer[], nickRaw: string, slot: number): LobbyPlayer[] {
  const nick = normalizeNick(nickRaw);

  if (nick === '') {
    throw new MatchServiceError('Nick cannot be empty.');
  }

  assertSlotInRange(slot);

  if (players.some((player) => player.slot === slot)) {
    throw new MatchServiceError(`Slot ${slot} is already occupied.`);
  }

  if (players.some((player) => player.nick === nick)) {
    throw new MatchServiceError(`Nick "${nick}" is already in the lobby.`);
  }

  return [...players, { slot, nick }];
}

export function removePlayer(
  players: LobbyPlayer[],
  options: { nick?: string | null; slot?: number | null },
): LobbyPlayer[] {
  const nickRaw = options.nick?.trim() ?? '';
  const hasNick = nickRaw !== '';
  const hasSlot = options.slot !== undefined && options.slot !== null;

  if (!hasNick && !hasSlot) {
    throw new MatchServiceError('Provide a nick and/or slot to remove.');
  }

  let target: LobbyPlayer | undefined;

  if (hasSlot) {
    const slot = options.slot!;
    assertSlotInRange(slot);
    target = players.find((player) => player.slot === slot);

    if (!target) {
      throw new MatchServiceError(`Slot ${slot} is empty.`);
    }

    if (hasNick) {
      const nick = normalizeNick(nickRaw);

      if (target.nick !== nick) {
        throw new MatchServiceError(
          `Slot ${slot} is occupied by "${target.nick}", not "${nick}".`,
        );
      }
    }
  } else {
    const nick = normalizeNick(nickRaw);
    target = players.find((player) => player.nick === nick);

    if (!target) {
      throw new MatchServiceError(`No player with nick "${nick}" in the lobby.`);
    }
  }

  return players.filter((player) => player.slot !== target!.slot);
}

export function movePlayer(
  players: LobbyPlayer[],
  fromSlot: number,
  toSlot: number,
): LobbyPlayer[] {
  assertSlotInRange(fromSlot);
  assertSlotInRange(toSlot);

  if (fromSlot === toSlot) {
    throw new MatchServiceError('Choose a different slot to move into.');
  }

  if (!players.some((player) => player.slot === fromSlot)) {
    throw new MatchServiceError(`Slot ${fromSlot} is empty.`);
  }

  // Occupied destination → swap (Change Slot / relocate UX).
  if (players.some((player) => player.slot === toSlot)) {
    return swapPlayers(players, fromSlot, toSlot);
  }

  return players.map((player) =>
    player.slot === fromSlot ? { ...player, slot: toSlot } : player,
  );
}

export function swapPlayers(
  players: LobbyPlayer[],
  slotA: number,
  slotB: number,
): LobbyPlayer[] {
  assertSlotInRange(slotA);
  assertSlotInRange(slotB);

  if (slotA === slotB) {
    throw new MatchServiceError('Choose two different slots to swap.');
  }

  const playerA = players.find((player) => player.slot === slotA);
  const playerB = players.find((player) => player.slot === slotB);

  if (!playerA) {
    throw new MatchServiceError(`Slot ${slotA} is empty.`);
  }

  if (!playerB) {
    throw new MatchServiceError(`Slot ${slotB} is empty.`);
  }

  return players.map((player) => {
    if (player.slot === slotA) {
      return { ...player, slot: slotB };
    }

    if (player.slot === slotB) {
      return { ...player, slot: slotA };
    }

    return player;
  });
}

export function editPlayerNick(
  players: LobbyPlayer[],
  slot: number,
  nickRaw: string,
): LobbyPlayer[] {
  assertSlotInRange(slot);

  const nick = normalizeNick(nickRaw);

  if (nick === '') {
    throw new MatchServiceError('Nick cannot be empty.');
  }

  if (!players.some((player) => player.slot === slot)) {
    throw new MatchServiceError('That player is no longer in the lobby.');
  }

  if (players.some((player) => player.nick === nick && player.slot !== slot)) {
    throw new MatchServiceError(`Nick "${nick}" is already in the lobby.`);
  }

  return players.map((player) => (player.slot === slot ? { ...player, nick } : player));
}

/**
 * Reject player claim/leave when the guild has turned the feature off.
 * Call before any roster mutation.
 */
export async function assertLobbyPlayerClaimEnabled(guildId: string): Promise<void> {
  const config = await resolveGuildConfig(guildId);

  if (!config.lobbyPlayerClaimEnabled) {
    throw new MatchServiceError(PLAYER_CLAIM_DISABLED_MESSAGE);
  }
}

/**
 * Seat a linked nick in an empty slot. Rejects occupied slots and nicks already in the lobby.
 */
export function rosterAfterClaim(
  players: LobbyPlayer[],
  nickRaw: string,
  slot: number,
): LobbyPlayer[] {
  const nick = normalizeNick(nickRaw);
  const existing = players.find((player) => player.nick === nick);

  if (existing) {
    if (existing.slot === slot) {
      throw new MatchServiceError(`You are already in slot ${slot}.`);
    }

    throw new MatchServiceError(ALREADY_IN_LOBBY_LEAVE_FIRST(existing.slot));
  }

  const occupant = players.find((player) => player.slot === slot);

  if (occupant) {
    throw new MatchServiceError(`Slot ${slot} is already occupied by "${occupant.nick}".`);
  }

  return addPlayer(players, nickRaw, slot);
}

/**
 * Remove the linked nick from the lobby (self-leave).
 */
export function rosterAfterLeave(players: LobbyPlayer[], nickRaw: string): LobbyPlayer[] {
  const nick = normalizeNick(nickRaw);
  const existing = players.find((player) => player.nick === nick);

  if (!existing) {
    throw new MatchServiceError(NOT_IN_LOBBY_MESSAGE);
  }

  return removePlayer(players, { nick });
}

function guildIdFromChannel(channel: object): string | undefined {
  if (!('guildId' in channel) || typeof channel.guildId !== 'string') {
    return undefined;
  }

  const guildId = channel.guildId.trim();
  return guildId || undefined;
}

async function resolvePlayerClaimEnabledForChannel(channel: object): Promise<boolean> {
  const guildId = guildIdFromChannel(channel);

  if (!guildId) {
    return true;
  }

  const config = await resolveGuildConfig(guildId);
  return config.lobbyPlayerClaimEnabled;
}

export async function syncLobbyDiscordMessage(
  client: Client,
  match: MatchWithPlayers,
  mode: LobbySyncMode,
  options: { ratingPreview?: LobbyRatingPreview } = {},
): Promise<void> {
  if (!match.discordMessageId || !match.discordChannelId) {
    log.warn({ matchId: match.id, mode }, 'Match has no Discord message to sync');
    return;
  }

  const channel = await client.channels.fetch(match.discordChannelId);

  if (!channel || !('messages' in channel)) {
    throw new Error('Missing channel for lobby message update');
  }

  const players = matchToLobbyPlayers(match);
  let payload: {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
  };

  if (mode === 'pending') {
    const canStart = canStartLobby(players);
    const ratingPreview = await loadLobbyRatingPreview(
      matchPlayersToRatingEntries(match.players),
    );
    const playerClaimEnabled = await resolvePlayerClaimEnabledForChannel(channel);
    payload = {
      embeds: [
        buildMatchLobbyEmbed(match.id, players, {
          canStart,
          createdAt: match.createdAt,
          ratingPreview,
          wc3statsGameId: match.wc3statsGameId,
          wc3statsLinkAvailable: env.wc3statsEnabled && !match.wc3statsGameId,
        }),
      ],
      components: buildLobbyButtons({
        canStart,
        playerCount: players.length,
        playerClaimEnabled,
        wc3statsGameId: match.wc3statsGameId,
        wc3statsEnabled: env.wc3statsEnabled,
      }),
    };
  } else if (mode === 'started') {
    const ratingPreview = await loadLobbyRatingPreview(
      matchPlayersToRatingEntries(match.players),
    );
    payload = {
      embeds: [buildMatchInProgressEmbed(match.id, players, { ratingPreview })],
      components: buildMatchReportButtons(),
    };
  } else if (mode === 'completed') {
    const ratingPreview =
      options.ratingPreview ??
      (await loadLobbyRatingPreview(matchPlayersToRatingEntries(match.players)));
    payload = {
      embeds: [
        buildMatchCompletedEmbed(match.id, players, {
          ratingPreview,
          winningTeam: determineWinningTeam(match.players),
        }),
      ],
      components: [],
    };
  } else {
    payload = {
      embeds: [buildMatchCancelledEmbed(match.id, 'by the host')],
      components: [],
    };
  }

  await channel.messages.edit(match.discordMessageId, payload);
  log.debug(
    { matchId: match.id, messageId: match.discordMessageId, mode, playerCount: players.length },
    'Lobby Discord message synced',
  );
}

async function applyRosterAndSync(
  client: Client,
  matchId: string,
  nextPlayers: LobbyPlayer[],
): Promise<LobbyActionResult> {
  const updated = await replaceMatchRoster(matchId, nextPlayers);
  await syncLobbyDiscordMessage(client, updated, 'pending');
  return { match: updated, players: matchToLobbyPlayers(updated) };
}

export async function addLobbyPlayer(input: {
  client: Client;
  hostDiscordId: string;
  matchId?: string | null;
  nick: string;
  slot: number;
}): Promise<LobbyActionResult> {
  const { match, players } = await resolveHostPendingMatch({
    hostDiscordId: input.hostDiscordId,
    matchId: input.matchId,
  });
  const next = addPlayer(players, input.nick, input.slot);
  return applyRosterAndSync(input.client, match.id, next);
}

/**
 * Host seats a linked Discord member. Not gated by player claim.
 */
export async function addLobbyPlayerFromDiscord(input: {
  client: Client;
  hostDiscordId: string;
  matchId?: string | null;
  discordId: string;
  slot: number;
}): Promise<LobbyActionResult> {
  const nick = await nickForDiscordId(input.discordId);
  return addLobbyPlayer({
    client: input.client,
    hostDiscordId: input.hostDiscordId,
    matchId: input.matchId,
    nick,
    slot: input.slot,
  });
}

/**
 * Linked player claims an empty PENDING slot. Gated by guild player-claim flag.
 */
export async function claimLobbySlot(input: {
  client: Client;
  messageId: string;
  discordId: string;
  guildId: string;
  slot: number;
}): Promise<LobbyActionResult> {
  await assertLobbyPlayerClaimEnabled(input.guildId);
  const nick = await nickForDiscordId(input.discordId);
  const { match, players } = await resolvePendingMatchByMessageId({
    messageId: input.messageId,
  });
  const next = rosterAfterClaim(players, nick, input.slot);
  return applyRosterAndSync(input.client, match.id, next);
}

/**
 * Linked player leaves the PENDING lobby. Gated by guild player-claim flag.
 */
export async function leaveLobbySlot(input: {
  client: Client;
  messageId: string;
  discordId: string;
  guildId: string;
}): Promise<LobbyActionResult> {
  await assertLobbyPlayerClaimEnabled(input.guildId);
  const nick = await nickForDiscordId(input.discordId);
  const { match, players } = await resolvePendingMatchByMessageId({
    messageId: input.messageId,
  });
  const next = rosterAfterLeave(players, nick);
  return applyRosterAndSync(input.client, match.id, next);
}

export async function removeLobbyPlayer(input: {
  client: Client;
  hostDiscordId: string;
  matchId?: string | null;
  nick?: string | null;
  slot?: number | null;
}): Promise<LobbyActionResult> {
  const { match, players } = await resolveHostPendingMatch({
    hostDiscordId: input.hostDiscordId,
    matchId: input.matchId,
  });
  const next = removePlayer(players, { nick: input.nick, slot: input.slot });
  return applyRosterAndSync(input.client, match.id, next);
}

export async function moveLobbyPlayer(input: {
  client: Client;
  hostDiscordId: string;
  matchId?: string | null;
  fromSlot: number;
  toSlot: number;
}): Promise<LobbyActionResult> {
  const { match, players } = await resolveHostPendingMatch({
    hostDiscordId: input.hostDiscordId,
    matchId: input.matchId,
  });
  const next = movePlayer(players, input.fromSlot, input.toSlot);
  return applyRosterAndSync(input.client, match.id, next);
}

export async function swapLobbyPlayers(input: {
  client: Client;
  hostDiscordId: string;
  matchId?: string | null;
  slotA: number;
  slotB: number;
}): Promise<LobbyActionResult> {
  const { match, players } = await resolveHostPendingMatch({
    hostDiscordId: input.hostDiscordId,
    matchId: input.matchId,
  });
  const next = swapPlayers(players, input.slotA, input.slotB);
  return applyRosterAndSync(input.client, match.id, next);
}

export async function editLobbyPlayerNick(input: {
  client: Client;
  hostDiscordId: string;
  matchId?: string | null;
  slot: number;
  nick: string;
}): Promise<LobbyActionResult> {
  const { match, players } = await resolveHostPendingMatch({
    hostDiscordId: input.hostDiscordId,
    matchId: input.matchId,
  });
  const next = editPlayerNick(players, input.slot, input.nick);
  return applyRosterAndSync(input.client, match.id, next);
}

/** Button/modal path: mutate by Discord message id (any user). */
export async function applyRosterUpdateForMessage(input: {
  client: Client;
  messageId: string;
  nextPlayers: LobbyPlayer[];
}): Promise<LobbyActionResult> {
  const { match } = await resolvePendingMatchByMessageId({
    messageId: input.messageId,
  });
  return applyRosterAndSync(input.client, match.id, input.nextPlayers);
}

export async function startLobbyMatch(input: {
  client: Client;
  hostDiscordId: string;
  matchId?: string | null;
}): Promise<LobbyActionResult> {
  const { match } = await resolveHostPendingMatch({
    hostDiscordId: input.hostDiscordId,
    matchId: input.matchId,
  });
  const started = await startMatch(match.id);
  await syncLobbyDiscordMessage(input.client, started, 'started');
  return { match: started, players: matchToLobbyPlayers(started) };
}

export async function startLobbyMatchByMessageId(input: {
  client: Client;
  messageId: string;
}): Promise<LobbyActionResult> {
  const { match } = await resolvePendingMatchByMessageId({
    messageId: input.messageId,
  });
  const started = await startMatch(match.id);
  await syncLobbyDiscordMessage(input.client, started, 'started');
  return { match: started, players: matchToLobbyPlayers(started) };
}

export async function cancelLobbyMatch(input: {
  client: Client;
  hostDiscordId: string;
  matchId?: string | null;
}): Promise<LobbyActionResult> {
  const { match } = await resolveHostPendingMatch({
    hostDiscordId: input.hostDiscordId,
    matchId: input.matchId,
  });
  const cancelled = await cancelMatch(match.id);
  await syncLobbyDiscordMessage(input.client, cancelled, 'cancelled');
  return { match: cancelled, players: matchToLobbyPlayers(cancelled) };
}

export interface RefreshLobbyResult extends LobbyActionResult {
  keptExisting: boolean;
  warning?: string;
  boundNow: boolean;
  message: string;
}

function refreshResultMessage(input: {
  boundNow: boolean;
  gameId?: string | null;
  warning?: string;
}): string {
  const parts: string[] = [];
  if (input.boundNow && input.gameId) {
    parts.push(`Linked Warcraft lobby \`${input.gameId}\`.`);
  }
  if (input.warning) {
    parts.push(input.warning);
  }
  return parts.join(' ') || LOBBY_UPDATED_MESSAGE;
}

type SuccessfulWc3statsImport = Extract<ImportWc3statsLobbyResult, { ok: true }>;

async function importAndMaybeLinkWc3stats(input: {
  match: MatchWithPlayers;
  wc3statsId?: number | null;
  guildId?: string | null;
}): Promise<{ match: MatchWithPlayers; imported: SuccessfulWc3statsImport; boundNow: boolean }> {
  const explicitId = input.wc3statsId ?? null;
  const storedId = input.match.wc3statsGameId?.trim() || null;
  let boundNow = false;
  let working = input.match;
  const slotMap = input.guildId ? await loadGuildWc3statsHeroSlotMap(input.guildId) : null;

  if (explicitId) {
    const imported = await importWc3statsLobby({ wc3statsId: explicitId, slotMap });
    if (!imported.ok) {
      throw new MatchServiceError(imported.message);
    }

    if (storedId !== imported.gameId) {
      working = await linkMatchWc3statsGameId(working.id, imported.gameId);
      boundNow = true;
    }

    return { match: working, imported, boundNow };
  }

  if (storedId) {
    const wc3statsId = Number(storedId);
    if (!Number.isInteger(wc3statsId) || wc3statsId <= 0) {
      throw new MatchServiceError(WC3STATS_NOT_LINKED_MESSAGE);
    }

    const imported = await importWc3statsLobby({ wc3statsId, slotMap });
    if (!imported.ok) {
      throw new MatchServiceError(imported.message);
    }

    return { match: working, imported, boundNow: false };
  }

  if (!env.wc3statsEnabled) {
    throw new MatchServiceError(WC3STATS_IMPORT_DISABLED_MESSAGE);
  }

  const hostNick = await nickForDiscordId(working.hostDiscordId);
  const imported = await importWc3statsLobby({
    hostNick,
    requireNickInLobby: true,
    slotMap,
  });
  if (!imported.ok) {
    throw new MatchServiceError(imported.message);
  }

  working = await linkMatchWc3statsGameId(working.id, imported.gameId);
  return { match: working, imported, boundNow: true };
}

/**
 * Host/mod Refresh of a PENDING lobby. Links a live UDBR game when none is stored yet
 * (host Discord must be linked with /link and seated in that lobby, or pass wc3stats_id).
 */
export async function refreshLobbyFromWc3stats(input: {
  client: Client;
  actorDiscordId: string;
  memberRoleIds: string[];
  matchModRoleId?: string;
  messageId?: string;
  matchId?: string | null;
  wc3statsId?: number | null;
  guildId?: string | null;
}): Promise<RefreshLobbyResult> {
  const match = input.messageId
    ? await getMatchByDiscordMessageId(input.messageId)
    : input.matchId
      ? await getMatchById(input.matchId)
      : null;

  if (!match) {
    throw new MatchServiceError(NOT_FOUND_MESSAGE);
  }

  if (match.status !== 'PENDING') {
    throw new MatchServiceError(NOT_EDITABLE_MESSAGE);
  }

  assertCanManageMatch({
    hostDiscordId: match.hostDiscordId,
    actorDiscordId: input.actorDiscordId,
    memberRoleIds: input.memberRoleIds,
    matchModRoleId: input.matchModRoleId,
  });

  const explicitId = input.wc3statsId ?? null;
  const storedId = match.wc3statsGameId?.trim() || null;
  if (!explicitId && !storedId) {
    if (!env.wc3statsEnabled) {
      throw new MatchServiceError(WC3STATS_IMPORT_DISABLED_MESSAGE);
    }
    await nickForDiscordId(match.hostDiscordId);
  }

  const lastRefreshAt = lastRefreshAtByMatchId.get(match.id);
  if (lastRefreshAt !== undefined && Date.now() - lastRefreshAt < REFRESH_DEBOUNCE_MS) {
    throw new MatchServiceError(WC3STATS_REFRESH_WAIT_MESSAGE);
  }
  lastRefreshAtByMatchId.set(match.id, Date.now());

  let guildId = input.guildId?.trim() || null;
  if (!guildId && match.discordChannelId) {
    try {
      const channel = await input.client.channels.fetch(match.discordChannelId);
      guildId = guildIdFromChannel(channel ?? {}) ?? null;
    } catch {
      guildId = null;
    }
  }

  const { match: linked, imported, boundNow } = await importAndMaybeLinkWc3stats({
    match,
    wc3statsId: input.wc3statsId,
    guildId,
  });

  const current = matchToLobbyPlayers(linked);
  const applied = applyWc3statsRefresh(current, imported.roster);
  const gameId = linked.wc3statsGameId;

  if (applied.keptExisting) {
    await syncLobbyDiscordMessage(input.client, linked, 'pending');
    return {
      match: linked,
      players: current,
      keptExisting: true,
      warning: WC3STATS_REFRESH_KEPT_MESSAGE,
      boundNow,
      message: refreshResultMessage({
        boundNow,
        gameId,
        warning: WC3STATS_REFRESH_KEPT_MESSAGE,
      }),
    };
  }

  const updated = await replaceMatchRoster(linked.id, applied.players);
  await syncLobbyDiscordMessage(input.client, updated, 'pending');
  return {
    match: updated,
    players: matchToLobbyPlayers(updated),
    keptExisting: false,
    boundNow,
    message: refreshResultMessage({ boundNow, gameId: updated.wc3statsGameId }),
  };
}
