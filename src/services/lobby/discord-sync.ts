import type { ActionRowBuilder, ButtonBuilder, Client, EmbedBuilder } from 'discord.js';
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
import { prisma } from '../../lib/prisma.js';
import { isLeagueWc3statsImportReady } from '../league/league-wc3stats.js';
import { getGameProfileForLeague } from '../league/league-profile.js';

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

async function resolveLeagueSettingsForLobby(
  leagueId: string,
): Promise<{ playerClaimEnabled: boolean; wc3statsReady: boolean }> {
  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    select: {
      lobbyPlayerClaimEnabled: true,
      wc3statsEnabled: true,
      wc3statsMapPattern: true,
    },
  });

  if (!league) {
    return { playerClaimEnabled: true, wc3statsReady: false };
  }

  return {
    playerClaimEnabled: league.lobbyPlayerClaimEnabled,
    wc3statsReady: isLeagueWc3statsImportReady({
      wc3statsEnabled: league.wc3statsEnabled,
      wc3statsMapPattern: league.wc3statsMapPattern ?? undefined,
    }),
  };
}

function determineWinningTeam(players: MatchWithPlayers['players']): 1 | 2 {
  return players.some((player) => player.result === 'WIN' && player.team === 1) ? 1 : 2;
}

export async function syncLobbyDiscordMessage(
  client: Client,
  match: MatchWithPlayers,
  mode: LobbySyncMode,
  options: { ratingPreview?: LobbyRatingPreview; cancelReason?: string } = {},
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
  const profile = await getGameProfileForLeague(match.leagueId);
  let payload: {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
  };

  if (mode === 'pending') {
    const canStart = canStartLobby(players, profile);
    const ratingPreview = await loadLobbyRatingPreview(
      match.leagueId,
      matchPlayersToRatingEntries(match.players),
    );
    const { playerClaimEnabled, wc3statsReady } =
      await resolveLeagueSettingsForLobby(match.leagueId);
    payload = {
      embeds: [
        buildMatchLobbyEmbed(match.id, players, {
          canStart,
          createdAt: match.createdAt,
          ratingPreview,
          wc3statsGameId: match.wc3statsGameId,
          wc3statsLinkAvailable: wc3statsReady && !match.wc3statsGameId,
          profile,
        }),
      ],
      components: buildLobbyButtons({
        canStart,
        playerCount: players.length,
        playerClaimEnabled,
        wc3statsGameId: match.wc3statsGameId,
        wc3statsEnabled: wc3statsReady,
        profile,
      }),
    };
  } else if (mode === 'started') {
    const ratingPreview = await loadLobbyRatingPreview(
      match.leagueId,
      matchPlayersToRatingEntries(match.players),
    );
    payload = {
      embeds: [buildMatchInProgressEmbed(match.id, players, { ratingPreview, profile })],
      components: buildMatchReportButtons(),
    };
  } else if (mode === 'completed') {
    const ratingPreview =
      options.ratingPreview ??
      (await loadLobbyRatingPreview(match.leagueId, matchPlayersToRatingEntries(match.players)));
    payload = {
      embeds: [
        buildMatchCompletedEmbed(match.id, players, {
          ratingPreview,
          winningTeam: determineWinningTeam(match.players),
          profile,
        }),
      ],
      components: [],
    };
  } else {
    payload = {
      embeds: [
        buildMatchCancelledEmbed(
          match.id,
          options.cancelReason ?? 'by the host',
        ),
      ],
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
