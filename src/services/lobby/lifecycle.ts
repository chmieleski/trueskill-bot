import type { Client } from 'discord.js';
import {
  cancelMatch,
  matchToLobbyPlayers,
  startMatch,
} from '../match/match-service.js';
import { type LobbyActionResult, syncLobbyDiscordMessage } from './discord-sync.js';
import {
  resolveHostPendingMatch,
  resolvePendingMatchByMessageId,
  resolvePendingMatchForManage,
} from './resolve.js';

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
  actorDiscordId: string;
  matchId?: string | null;
  memberRoleIds: string[];
  matchModRoleId?: string;
}): Promise<LobbyActionResult> {
  const { match } = await resolvePendingMatchForManage({
    actorDiscordId: input.actorDiscordId,
    matchId: input.matchId,
    memberRoleIds: input.memberRoleIds,
    matchModRoleId: input.matchModRoleId,
  });
  const cancelled = await cancelMatch(match.id);
  const cancelReason =
    match.hostDiscordId === input.actorDiscordId ? 'by the host' : 'by a moderator';
  await syncLobbyDiscordMessage(input.client, cancelled, 'cancelled', { cancelReason });
  return { match: cancelled, players: matchToLobbyPlayers(cancelled) };
}
