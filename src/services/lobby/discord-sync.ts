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
import { collectNewPlayerSuggestions, type NewPlayerSuggestion } from '../rating/new-player.js';
import { prisma } from '../../lib/prisma.js';
import { isLeagueWc3statsImportReady } from '../league/league-wc3stats.js';
import { getGameProfileForMatch, isEventMatch, requireLeagueId } from '../match/match-service.js';
import { getEventById } from '../event/event.js';
import { resolveGuildConfig } from '../guild/guild-config.js';
import { enrichCompletedMatchLogEmbeds } from '../match/match-stats-upload.js';

const log = createLogger('lobby-discord-sync');

export type LobbySyncMode = 'pending' | 'started' | 'cancelled' | 'completed';

export interface LobbyActionResult {
  match: MatchWithPlayers;
  players: LobbyPlayer[];
  /** First-timers newly seated on this sync (host/mod may confirm New). */
  newPlayerSuggestions?: NewPlayerSuggestion[];
}

/** Attach New-player suggest payloads for players seated since `previousPlayerIds`. */
export async function withNewPlayerSuggestions(
  result: LobbyActionResult,
  previousPlayerIds: Set<string>,
): Promise<LobbyActionResult> {
  if (isEventMatch(result.match)) {
    return { ...result, newPlayerSuggestions: [] };
  }
  const newPlayerSuggestions = await collectNewPlayerSuggestions({
    leagueId: requireLeagueId(result.match),
    matchId: result.match.id,
    previousPlayerIds,
    nextPlayers: result.match.players.map((player) => ({
      playerId: player.playerId,
      username: player.player.username,
    })),
  });
  return { ...result, newPlayerSuggestions };
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
  options: {
    ratingPreview?: LobbyRatingPreview;
    cancelReason?: string;
    postToMatchLog?: boolean;
  } = {},
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
  const profile = await getGameProfileForMatch(match);
  const eventName = match.eventId ? ((await getEventById(match.eventId))?.name ?? null) : null;
  const isEvent = isEventMatch(match);
  let payload: {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
  };

  if (mode === 'pending') {
    const canStart = canStartLobby(players, profile);
    const ratingPreview = isEvent
      ? undefined
      : await loadLobbyRatingPreview(
          requireLeagueId(match),
          matchPlayersToRatingEntries(match.players),
        );
    const { playerClaimEnabled, wc3statsReady } = isEvent
      ? { playerClaimEnabled: false, wc3statsReady: false }
      : await resolveLeagueSettingsForLobby(requireLeagueId(match));
    payload = {
      embeds: [
        buildMatchLobbyEmbed(match.id, players, {
          canStart,
          createdAt: match.createdAt,
          ratingPreview,
          wc3statsGameId: match.wc3statsGameId,
          wc3statsLinkAvailable: wc3statsReady && !match.wc3statsGameId,
          profile,
          eventName,
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
    const ratingPreview = isEvent
      ? undefined
      : await loadLobbyRatingPreview(
          requireLeagueId(match),
          matchPlayersToRatingEntries(match.players),
        );
    const pendingMitigation =
      match.status === 'WAITING_FOR_MITIGATION_APPROVAL'
        ? `\nAwaiting mod approval for **${match.ratingMitigationPercent ?? '?'}%** mitigation.`
        : '';
    const inProgressEmbed = buildMatchInProgressEmbed(match.id, players, {
      ratingPreview,
      profile,
      eventName,
    });
    if (pendingMitigation) {
      const prior = inProgressEmbed.data.description ?? '';
      inProgressEmbed.setDescription(`${prior}${pendingMitigation}`);
    }
    payload = {
      embeds: [inProgressEmbed],
      components:
        match.status === 'WAITING_FOR_MITIGATION_APPROVAL' ? [] : buildMatchReportButtons(profile),
    };
  } else if (mode === 'completed') {
    const ratingPreview = isEvent
      ? (options.ratingPreview ?? { players: [] })
      : (options.ratingPreview ??
        (await loadLobbyRatingPreview(
          requireLeagueId(match),
          matchPlayersToRatingEntries(match.players),
        )));
    payload = {
      embeds: [
        buildMatchCompletedEmbed(match.id, players, {
          ratingPreview,
          winningTeam: determineWinningTeam(match.players),
          profile,
          eventName,
          mitigationPercent: match.ratingMitigationPercent,
        }),
      ],
      components: [],
    };
  } else {
    payload = {
      embeds: [
        buildMatchCancelledEmbed(match.id, options.cancelReason ?? 'by the host', { eventName }),
      ],
      components: [],
    };
  }

  await channel.messages.edit(match.discordMessageId, payload);
  log.debug(
    { matchId: match.id, messageId: match.discordMessageId, mode, playerCount: players.length },
    'Lobby Discord message synced',
  );

  if (options.postToMatchLog && (mode === 'completed' || mode === 'cancelled')) {
    await postCompletedMatchLog(client, match, payload, {
      enrichStats: mode === 'completed',
    });
  }
}

/** Post a match embed to the guild completed-match log channel when configured. */
export async function postCompletedMatchLog(
  client: Client,
  match: MatchWithPlayers,
  payload: { embeds: EmbedBuilder[] },
  options: { enrichStats?: boolean } = {},
): Promise<void> {
  if (!match.discordChannelId) {
    return;
  }

  const sourceChannel = await client.channels.fetch(match.discordChannelId);
  const guildId = sourceChannel ? guildIdFromChannel(sourceChannel) : undefined;
  if (!guildId) {
    return;
  }

  const { completedMatchLogChannelId } = await resolveGuildConfig(guildId);
  if (!completedMatchLogChannelId || completedMatchLogChannelId === match.discordChannelId) {
    return;
  }

  const logChannel = await client.channels.fetch(completedMatchLogChannelId);
  if (!logChannel || !('send' in logChannel) || typeof logChannel.send !== 'function') {
    log.warn(
      { matchId: match.id, guildId, channelId: completedMatchLogChannelId },
      'Completed match log channel is missing or cannot receive messages',
    );
    return;
  }

  try {
    const embeds =
      options.enrichStats === false
        ? payload.embeds
        : await enrichCompletedMatchLogEmbeds(match, payload.embeds);
    await logChannel.send({ embeds });
    log.debug(
      { matchId: match.id, guildId, channelId: completedMatchLogChannelId },
      'Completed match posted to log channel',
    );
  } catch (error) {
    log.warn(
      { err: error, matchId: match.id, guildId, channelId: completedMatchLogChannelId },
      'Failed to post completed match to log channel',
    );
  }
}

/** Persist a new roster then sync the Discord embed. */
export async function applyRosterAndSync(
  client: Client,
  matchId: string,
  nextPlayers: LobbyPlayer[],
): Promise<LobbyActionResult> {
  const updated = await replaceMatchRoster(matchId, nextPlayers, {
    markLobbyRosterAuthority: true,
  });
  await syncLobbyDiscordMessage(client, updated, 'pending');
  return { match: updated, players: matchToLobbyPlayers(updated) };
}
