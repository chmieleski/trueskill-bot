import type { Client } from 'discord.js';
import { invalidSlotMessage, isSlotInProfile } from '../../domain/game-profile.js';
import {
  MatchServiceError,
  getGameProfileForMatch,
  matchToLobbyPlayers,
  requireLeagueId,
  setMatchPlayersLocked,
} from '../match/match-service.js';
import { prisma } from '../../lib/prisma.js';
import { nickForDiscordId } from './lobby-identity.js';
import { normalizeNick } from '../player/player-nick.js';
import {
  addPlayer,
  editPlayerNick,
  movePlayer,
  removePlayer,
  rosterAfterClaim,
  rosterAfterLeave,
  swapPlayers,
} from './roster.js';
import { applyRemapPairs } from './remap.js';
import { findBalancedRoster, type NewPlayerSplit } from './lobby-balance.js';
import {
  loadBalanceContext,
  matchPlayersToRatingEntries,
  type WinChancePercents,
} from '../rating/rating-preview.js';
import {
  applyRosterAndSync,
  syncLobbyDiscordMessage,
  withNewPlayerSuggestions,
  type LobbyActionResult,
} from './discord-sync.js';
import {
  resolveHostPendingMatch,
  resolvePendingMatchByMessageId,
  resolvePendingMatchForManage,
} from './resolve.js';
import type { LobbyPlayer } from './lobby-ocr.js';
import { type LobbyLockMode, lockChangesForSelection } from './locked-slots.js';

export type { LobbyActionResult };

const PLAYER_CLAIM_DISABLED_MESSAGE = 'Player slot claim is disabled on this server.';

function previousPlayerIdsFromMatch(match: { players: Array<{ playerId: string }> }): Set<string> {
  return new Set(match.players.map((player) => player.playerId));
}

/**
 * Reject player claim/leave when the league has turned the feature off.
 */
export async function assertLobbyPlayerClaimEnabled(leagueId: string): Promise<void> {
  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    select: { lobbyPlayerClaimEnabled: true },
  });

  if (league?.lobbyPlayerClaimEnabled === false) {
    throw new MatchServiceError(PLAYER_CLAIM_DISABLED_MESSAGE);
  }
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
  const profile = await getGameProfileForMatch(match);
  const next = addPlayer(players, input.nick, input.slot, profile);
  const beforeIds = previousPlayerIdsFromMatch(match);
  const result = await applyRosterAndSync(input.client, match.id, next);
  return withNewPlayerSuggestions(result, beforeIds);
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
  const { match, players } = await resolveHostPendingMatch({
    hostDiscordId: input.hostDiscordId,
    matchId: input.matchId,
  });
  const profile = await getGameProfileForMatch(match);
  const nick = await nickForDiscordId(input.discordId, profile.gameId);
  const next = addPlayer(players, nick, input.slot, profile);
  const beforeIds = previousPlayerIdsFromMatch(match);
  const result = await applyRosterAndSync(input.client, match.id, next);
  return withNewPlayerSuggestions(result, beforeIds);
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
  const { match, players } = await resolvePendingMatchByMessageId({
    messageId: input.messageId,
  });
  await assertLobbyPlayerClaimEnabled(requireLeagueId(match));
  const profile = await getGameProfileForMatch(match);
  const nick = await nickForDiscordId(input.discordId, profile.gameId);
  const next = rosterAfterClaim(players, nick, input.slot, profile);
  const beforeIds = previousPlayerIdsFromMatch(match);
  const result = await applyRosterAndSync(input.client, match.id, next);
  return withNewPlayerSuggestions(result, beforeIds);
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
  const { match, players } = await resolvePendingMatchByMessageId({
    messageId: input.messageId,
  });
  await assertLobbyPlayerClaimEnabled(requireLeagueId(match));
  const profile = await getGameProfileForMatch(match);
  const nick = await nickForDiscordId(input.discordId, profile.gameId);
  const next = rosterAfterLeave(players, nick, profile);
  return applyRosterAndSync(input.client, match.id, next);
}

export async function removeLobbyPlayer(input: {
  client: Client;
  actorDiscordId: string;
  matchId?: string | null;
  nick?: string | null;
  slot?: number | null;
  memberRoleIds: string[];
  matchModRoleId?: string;
}): Promise<LobbyActionResult> {
  const { match, players } = await resolvePendingMatchForManage({
    actorDiscordId: input.actorDiscordId,
    matchId: input.matchId,
    memberRoleIds: input.memberRoleIds,
    matchModRoleId: input.matchModRoleId,
  });
  const profile = await getGameProfileForMatch(match);
  const next = removePlayer(players, { nick: input.nick, slot: input.slot }, profile);
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
  const profile = await getGameProfileForMatch(match);
  const next = movePlayer(players, input.fromSlot, input.toSlot, profile);
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
  const profile = await getGameProfileForMatch(match);
  const next = swapPlayers(players, input.slotA, input.slotB, profile);
  return applyRosterAndSync(input.client, match.id, next);
}

/**
 * Host `/lobby swap pairs`: apply sequential seat remaps, then persist and sync.
 */
export async function remapLobbyPlayers(input: {
  client: Client;
  hostDiscordId: string;
  matchId?: string | null;
  pairs: string;
}): Promise<LobbyActionResult> {
  const { match, players } = await resolveHostPendingMatch({
    hostDiscordId: input.hostDiscordId,
    matchId: input.matchId,
  });
  const profile = await getGameProfileForMatch(match);
  const next = applyRemapPairs(players, input.pairs, profile);
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
  const profile = await getGameProfileForMatch(match);
  const next = editPlayerNick(players, input.slot, input.nick, profile);
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
  const beforeIds = previousPlayerIdsFromMatch(match);
  const result = await applyRosterAndSync(input.client, match.id, input.nextPlayers);
  return withNewPlayerSuggestions(result, beforeIds);
}

type ManageLobbyInput = {
  client: Client;
  actorDiscordId: string;
  matchId?: string | null;
  memberRoleIds: string[];
  matchModRoleId?: string;
};

async function syncAfterLock(
  client: Client,
  match: Awaited<ReturnType<typeof setMatchPlayersLocked>>,
): Promise<LobbyActionResult> {
  await syncLobbyDiscordMessage(client, match, 'pending');
  return { match, players: matchToLobbyPlayers(match) };
}

/** "slot 3" / "slots 1, 3, 7" for lock replies. */
export function formatSlotList(slots: number[]): string {
  return `${slots.length === 1 ? 'slot' : 'slots'} ${slots.join(', ')}`;
}

/**
 * Lock occupied PENDING seats (host or match mod). `slot` (default) pins the
 * player↔slot pair; `side` keeps the player on their team. Replaces any other
 * lock mode on those seats.
 */
export async function lockLobbySlots(
  input: ManageLobbyInput & { slots: number[]; mode?: Exclude<LobbyLockMode, 'none'> },
): Promise<LobbyActionResult> {
  const { match } = await resolvePendingMatchForManage(input);
  const mode = input.mode ?? 'slot';
  const updated = await setMatchPlayersLocked(
    match.id,
    input.slots.map((slot) => ({ slot, mode })),
  );
  return syncAfterLock(input.client, updated);
}

/** Clear slot and side locks on PENDING seats (host or match mod). Idempotent when unlocked. */
export async function unlockLobbySlots(
  input: ManageLobbyInput & { slots: number[] },
): Promise<LobbyActionResult> {
  const { match } = await resolvePendingMatchForManage(input);
  const updated = await setMatchPlayersLocked(
    match.id,
    input.slots.map((slot) => ({ slot, mode: 'none' as const })),
  );
  return syncAfterLock(input.client, updated);
}

/**
 * Give exactly `lockedSlots` the `mode` lock and clear that mode from every other
 * occupied seat (button path). Seats holding the other mode are left alone.
 */
export async function setLobbyLockedSlots(
  input: ManageLobbyInput & { lockedSlots: number[]; mode?: Exclude<LobbyLockMode, 'none'> },
): Promise<LobbyActionResult> {
  const { match, players } = await resolvePendingMatchForManage(input);
  const occupied = new Set(players.map((player) => player.slot));
  const stale = input.lockedSlots.find((slot) => !occupied.has(slot));
  if (stale !== undefined) {
    throw new MatchServiceError(`Nobody in slot ${stale} to lock.`);
  }
  const updated = await setMatchPlayersLocked(
    match.id,
    lockChangesForSelection(players, new Set(input.lockedSlots), input.mode ?? 'slot'),
  );
  return syncAfterLock(input.client, updated);
}

/**
 * Re-seat unlocked players for a 50/50 or 51/49 win chance (host or match mod).
 * Each call picks a different seating; locked seats stay put and side-locked
 * players stay on their team.
 */
export async function balanceLobbyRoster(input: ManageLobbyInput): Promise<
  LobbyActionResult & {
    winChance: WinChancePercents;
    balanced: boolean;
    teamSplit: NewPlayerSplit;
    newSplit: NewPlayerSplit;
    calibratingSplit: NewPlayerSplit;
  }
> {
  const { match } = await resolvePendingMatchForManage({
    actorDiscordId: input.actorDiscordId,
    matchId: input.matchId,
    memberRoleIds: input.memberRoleIds,
    matchModRoleId: input.matchModRoleId,
  });
  const profile = await getGameProfileForMatch(match);
  const { roster, lookup, options } = await loadBalanceContext(
    requireLeagueId(match),
    matchPlayersToRatingEntries(match.players),
  );
  const result = findBalancedRoster(roster, lookup, options, profile);
  if (!result) {
    throw new MatchServiceError(
      'Could not find a better seating. Unlock some seats and try again.',
    );
  }
  const next: LobbyPlayer[] = result.roster.map((entry) => ({
    slot: entry.slot,
    nick: normalizeNick(entry.nick),
    ...(entry.locked === true ? { locked: true as const } : {}),
    ...(entry.sideLocked === true ? { sideLocked: true as const } : {}),
  }));
  const synced = await applyRosterAndSync(input.client, match.id, next);
  return {
    ...synced,
    winChance: result.winChance,
    balanced: result.balanced,
    teamSplit: result.teamSplit,
    newSplit: result.newSplit,
    calibratingSplit: result.calibratingSplit,
  };
}

/** Ephemeral reply for the Balance button and `/lobby balance`. */
export function balanceResultMessage(
  result: Awaited<ReturnType<typeof balanceLobbyRoster>>,
): string {
  const { teamAPercent, teamBPercent } = result.winChance;
  const prefix = result.balanced ? 'Balanced' : 'Closest found';
  const unevenNote = (label: string, split: NewPlayerSplit) =>
    split.even ? '' : `\n${label} split ${split.team1}/${split.team2} because of locked seats.`;
  const notes =
    unevenNote('Teams', result.teamSplit) +
    unevenNote('New players', result.newSplit) +
    unevenNote('Calibrating players', result.calibratingSplit);
  return `${prefix} → **${teamAPercent}% / ${teamBPercent}%** in match \`${result.match.id}\`. Click again for another combination.${notes}`;
}
