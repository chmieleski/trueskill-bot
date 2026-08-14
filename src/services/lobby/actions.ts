import type { Client } from 'discord.js';
import { MatchServiceError } from '../match/match-service.js';
import { resolveGuildConfig } from '../guild/guild-config.js';
import { nickForDiscordId } from './lobby-identity.js';
import {
  addPlayer,
  editPlayerNick,
  movePlayer,
  removePlayer,
  rosterAfterClaim,
  rosterAfterLeave,
  swapPlayers,
} from './roster.js';
import { applyRosterAndSync, type LobbyActionResult } from './discord-sync.js';
import {
  resolveHostPendingMatch,
  resolvePendingMatchByMessageId,
} from './resolve.js';
import type { LobbyPlayer } from './lobby-ocr.js';

export type { LobbyActionResult };

const PLAYER_CLAIM_DISABLED_MESSAGE = 'Player slot claim is disabled on this server.';

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
