import type { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import {
  clearLeagueLeaderboardChannel,
  setLeagueLeaderboardChannel,
} from '../league/league-wc3stats.js';
import {
  LIVE_LEADERBOARD_DEFAULT_SIZE,
  loadOverallLeaderboardTop,
} from './leaderboard.js';
import { buildOverallLiveLeaderboardEmbeds } from './leaderboard-embed.js';
import { refreshAllQuitterLeaderboardChannels } from './quitter-leaderboard-channel.js';

const log = createLogger('leaderboard_channel');
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | undefined;

async function fetchTextChannel(client: Client, channelId: string): Promise<TextChannel> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    throw new Error(`Channel ${channelId} is not a guild text channel`);
  }
  return channel as TextChannel;
}

async function deleteMessageBestEffort(
  client: Client,
  channelId: string,
  messageId: string,
): Promise<void> {
  try {
    const channel = await fetchTextChannel(client, channelId);
    await channel.messages.delete(messageId);
  } catch (error) {
    log.warn({ err: error, channelId, messageId }, 'Failed to delete leaderboard message');
  }
}

async function buildLiveOverallEmbeds(
  leagueId: string,
  size?: number,
): Promise<EmbedBuilder[]> {
  let resolvedSize = size;
  if (resolvedSize === undefined) {
    const row = await prisma.league.findUnique({
      where: { id: leagueId },
      select: { leaderboardSize: true },
    });
    resolvedSize = row?.leaderboardSize ?? LIVE_LEADERBOARD_DEFAULT_SIZE;
  }
  const entries = await loadOverallLeaderboardTop(leagueId, resolvedSize);
  return buildOverallLiveLeaderboardEmbeds(entries, new Date());
}

export async function setupLiveLeaderboard(
  client: Client,
  leagueId: string,
  channelId: string,
): Promise<{ messageId: string }> {
  const existing = await prisma.league.findUnique({
    where: { id: leagueId },
    select: {
      leaderboardChannelId: true,
      leaderboardMessageId: true,
      leaderboardSize: true,
    },
  });
  if (existing?.leaderboardMessageId && existing.leaderboardChannelId) {
    await deleteMessageBestEffort(
      client,
      existing.leaderboardChannelId,
      existing.leaderboardMessageId,
    );
  }

  const embeds = await buildLiveOverallEmbeds(
    leagueId,
    existing?.leaderboardSize ?? LIVE_LEADERBOARD_DEFAULT_SIZE,
  );
  const channel = await fetchTextChannel(client, channelId);
  const message = await channel.send({ embeds });

  await setLeagueLeaderboardChannel(leagueId, channelId, message.id);

  return { messageId: message.id };
}

export async function clearLiveLeaderboard(client: Client, leagueId: string): Promise<void> {
  const row = await prisma.league.findUnique({
    where: { id: leagueId },
    select: { leaderboardChannelId: true, leaderboardMessageId: true },
  });
  if (row?.leaderboardChannelId && row.leaderboardMessageId) {
    await deleteMessageBestEffort(client, row.leaderboardChannelId, row.leaderboardMessageId);
  }

  await clearLeagueLeaderboardChannel(leagueId);
}

export async function refreshLeagueLeaderboard(
  client: Client,
  leagueId: string,
): Promise<void> {
  const row = await prisma.league.findUnique({
    where: { id: leagueId },
    select: {
      leaderboardChannelId: true,
      leaderboardMessageId: true,
      leaderboardSize: true,
    },
  });
  if (!row?.leaderboardChannelId || !row.leaderboardMessageId) {
    return;
  }

  const embeds = await buildLiveOverallEmbeds(
    leagueId,
    row.leaderboardSize ?? LIVE_LEADERBOARD_DEFAULT_SIZE,
  );

  try {
    const channel = await fetchTextChannel(client, row.leaderboardChannelId);
    await channel.messages.edit(row.leaderboardMessageId, { embeds });
  } catch (error) {
    log.warn({ err: error, leagueId }, 'Leaderboard edit failed; reposting');
    try {
      const channel = await fetchTextChannel(client, row.leaderboardChannelId);
      const message = await channel.send({ embeds });
      await setLeagueLeaderboardChannel(leagueId, row.leaderboardChannelId, message.id);
    } catch (repostError) {
      log.warn({ err: repostError, leagueId }, 'Leaderboard repost failed');
    }
  }
}

export async function refreshAllLeaderboardChannels(client: Client): Promise<void> {
  const leagues = await prisma.league.findMany({
    where: {
      leaderboardChannelId: { not: null },
      leaderboardMessageId: { not: null },
    },
    select: { id: true },
  });

  for (const league of leagues) {
    await refreshLeagueLeaderboard(client, league.id);
  }

  await refreshAllQuitterLeaderboardChannels(client);
}

export function scheduleLeaderboardRefresh(client: Client): void {
  if (intervalHandle) {
    return;
  }

  intervalHandle = setInterval(() => {
    void refreshAllLeaderboardChannels(client).catch((error) => {
      log.warn({ err: error }, 'Scheduled leaderboard refresh failed');
    });
  }, REFRESH_INTERVAL_MS);
}

export function stopLeaderboardRefreshScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
}
