import type { ActionRowBuilder, ButtonBuilder, Client, EmbedBuilder } from 'discord.js';
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
  matchToLobbyPlayers,
  MatchServiceError,
  replaceMatchRoster,
  startMatch,
  type MatchWithPlayers,
} from './match-service.js';
import {
  loadLobbyRatingPreview,
  matchPlayersToRatingEntries,
} from './rating-preview.js';
const log = createLogger('lobby-actions');

const MIN_SLOT = 1;
const MAX_SLOT = 12;

const OWNER_ONLY_MESSAGE = 'Only the user who registered this lobby can do that.';
const NOT_FOUND_MESSAGE = 'This match lobby was not found. Run /register_lobby again.';
const NOT_EDITABLE_MESSAGE = 'This match can no longer be edited.';
const NO_PENDING_MESSAGE = 'You have no pending match lobby. Run /register_lobby first.';
const AMBIGUOUS_PENDING_MESSAGE =
  'You have more than one pending lobby. Pass match_id to choose which one.';

export type LobbySyncMode = 'pending' | 'started' | 'cancelled' | 'completed';

export interface LobbyActionResult {
  match: MatchWithPlayers;
  players: LobbyPlayer[];
}

export interface ResolveHostPendingMatchInput {
  hostDiscordId: string;
  matchId?: string | null;
}

function normalizeNick(nick: string): string {
  return nick.trim().toLowerCase();
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

export async function syncLobbyDiscordMessage(
  client: Client,
  match: MatchWithPlayers,
  mode: LobbySyncMode,
): Promise<void> {
  if (!match.discordMessageId || !match.discordChannelId) {
    log.warn({ matchId: match.id, mode }, 'Match has no Discord message to sync');
    return;
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
    payload = {
      embeds: [
        buildMatchLobbyEmbed(match.id, players, {
          canStart,
          createdAt: match.createdAt,
          ratingPreview,
        }),
      ],
      components: buildLobbyButtons({ canStart }),
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
    const ratingPreview = await loadLobbyRatingPreview(
      matchPlayersToRatingEntries(match.players),
    );
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

  const channel = await client.channels.fetch(match.discordChannelId);

  if (!channel || !('messages' in channel)) {
    throw new Error('Missing channel for lobby message update');
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
