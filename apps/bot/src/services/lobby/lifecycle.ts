import type { Client } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { cancelActiveLobbyDraftForMatch } from '../lobby-draft/index.js';
import { cancelMatch, matchToLobbyPlayers, startMatch } from '../match/match-service.js';
import { type LobbyActionResult, syncLobbyDiscordMessage } from './discord-sync.js';
import {
  resolveHostPendingMatch,
  resolvePendingMatchByMessageId,
  resolvePendingMatchForManage,
} from './resolve.js';

const log = createLogger('lobby-lifecycle');

/** Best-effort: the match status already changed, so a draft-cancel failure must not fail the action. */
async function cancelDraftBestEffort(client: Client, matchId: string, reason: string) {
  try {
    await cancelActiveLobbyDraftForMatch(client, matchId, reason);
  } catch (error) {
    log.warn({ err: error, matchId }, 'Failed to cancel lobby captain draft');
  }
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
  await cancelDraftBestEffort(input.client, match.id, 'the lobby was started.');
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
  await cancelDraftBestEffort(input.client, match.id, 'the lobby was started.');
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
  await cancelDraftBestEffort(input.client, match.id, 'the lobby was cancelled.');
  const cancelReason =
    match.hostDiscordId === input.actorDiscordId ? 'by the host' : 'by a moderator';
  await syncLobbyDiscordMessage(input.client, cancelled, 'cancelled', { cancelReason });
  return { match: cancelled, players: matchToLobbyPlayers(cancelled) };
}
