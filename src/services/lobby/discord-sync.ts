import type { ActionRowBuilder, ButtonBuilder, Client, EmbedBuilder } from 'discord.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../lib/logger.js';
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
  matchToLobbyPlayers,
  replaceMatchRoster,
  type MatchWithPlayers,
} from '../match/match-service.js';
import {
  loadLobbyRatingPreview,
  matchPlayersToRatingEntries,
  type LobbyRatingPreview,
} from '../rating/rating-preview.js';
import { resolveGuildConfig } from '../guild/guild-config.js';

const log = createLogger('lobby-discord-sync');

export type LobbySyncMode = 'pending' | 'started' | 'cancelled' | 'completed';

export interface LobbyActionResult {
  match: MatchWithPlayers;
  players: LobbyPlayer[];
}

/** Extract the guildId string from a Discord channel object. */
export function guildIdFromChannel(channel: object): string | undefined {
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

function determineWinningTeam(players: MatchWithPlayers['players']): 1 | 2 {
  return players.some((player) => player.result === 'WIN' && player.slot <= 6) ? 1 : 2;
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

/** Persist a new roster then sync the Discord embed. */
export async function applyRosterAndSync(
  client: Client,
  matchId: string,
  nextPlayers: LobbyPlayer[],
): Promise<LobbyActionResult> {
  const updated = await replaceMatchRoster(matchId, nextPlayers);
  await syncLobbyDiscordMessage(client, updated, 'pending');
  return { match: updated, players: matchToLobbyPlayers(updated) };
}
