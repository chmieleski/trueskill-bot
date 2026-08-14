import type { Client } from 'discord.js';
import {
  cancelMatch,
  matchToLobbyPlayers,
  startMatch,
} from '../match/match-service.js';
import { type LobbyActionResult, syncLobbyDiscordMessage } from './discord-sync.js';
import { resolveHostPendingMatch, resolvePendingMatchByMessageId } from './resolve.js';

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
