import type { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import {
  clearGrieferLeaderboardChannel,
  setGrieferLeaderboardChannel,
} from '../guild/guild-config.js';
import { LIVE_LEADERBOARD_DEFAULT_SIZE } from './leaderboard.js';
import {
  loadGrieferLeaderboardTop,
  type GrieferLeaderboardDisplayMode,
  type GrieferLeaderboardSortMode,
} from './griefer-leaderboard.js';
import { buildGrieferLiveLeaderboardEmbeds } from './griefer-leaderboard-embed.js';

const log = createLogger('griefer_leaderboard_channel');

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
    log.warn({ err: error, channelId, messageId }, 'Failed to delete griefer leaderboard message');
  }
}

async function buildLiveGrieferEmbeds(
  guildId: string,
  size?: number,
  display?: GrieferLeaderboardDisplayMode,
  sort?: GrieferLeaderboardSortMode,
): Promise<EmbedBuilder[]> {
  let resolvedSize = size;
  let resolvedDisplay = display;
  let resolvedSort = sort;

  if (resolvedSize === undefined || resolvedDisplay === undefined || resolvedSort === undefined) {
    const row = await prisma.guildConfig.findUnique({
      where: { guildId },
      select: {
        grieferLeaderboardSize: true,
        grieferLeaderboardDisplay: true,
        grieferLeaderboardSort: true,
      },
    });
    resolvedSize = resolvedSize ?? row?.grieferLeaderboardSize ?? LIVE_LEADERBOARD_DEFAULT_SIZE;
    resolvedDisplay = resolvedDisplay ?? row?.grieferLeaderboardDisplay ?? 'both';
    resolvedSort = resolvedSort ?? row?.grieferLeaderboardSort ?? 'count';
  }

  const entries = await loadGrieferLeaderboardTop(
    guildId,
    resolvedSize,
    resolvedDisplay,
    resolvedSort,
  );
  return buildGrieferLiveLeaderboardEmbeds(entries, resolvedDisplay, resolvedSort, new Date());
}

/** Post a live griefer leaderboard message and bind it on GuildConfig. */
export async function setupGrieferLiveLeaderboard(
  client: Client,
  guildId: string,
  channelId: string,
): Promise<{ messageId: string }> {
  const existing = await prisma.guildConfig.findUnique({
    where: { guildId },
    select: {
      grieferLeaderboardChannelId: true,
      grieferLeaderboardMessageId: true,
      grieferLeaderboardSize: true,
      grieferLeaderboardDisplay: true,
      grieferLeaderboardSort: true,
    },
  });
  if (existing?.grieferLeaderboardMessageId && existing.grieferLeaderboardChannelId) {
    await deleteMessageBestEffort(
      client,
      existing.grieferLeaderboardChannelId,
      existing.grieferLeaderboardMessageId,
    );
  }

  const embeds = await buildLiveGrieferEmbeds(
    guildId,
    existing?.grieferLeaderboardSize ?? LIVE_LEADERBOARD_DEFAULT_SIZE,
    existing?.grieferLeaderboardDisplay ?? 'both',
    existing?.grieferLeaderboardSort ?? 'count',
  );
  const channel = await fetchTextChannel(client, channelId);
  const message = await channel.send({ embeds });

  await setGrieferLeaderboardChannel(guildId, channelId, message.id);

  return { messageId: message.id };
}

/** Delete the live griefer message (best-effort) and clear GuildConfig binding. */
export async function clearGrieferLiveLeaderboard(client: Client, guildId: string): Promise<void> {
  const row = await prisma.guildConfig.findUnique({
    where: { guildId },
    select: {
      grieferLeaderboardChannelId: true,
      grieferLeaderboardMessageId: true,
    },
  });
  if (row?.grieferLeaderboardChannelId && row.grieferLeaderboardMessageId) {
    await deleteMessageBestEffort(
      client,
      row.grieferLeaderboardChannelId,
      row.grieferLeaderboardMessageId,
    );
  }

  await clearGrieferLeaderboardChannel(guildId);
}

/** Edit (or repost) the guild's bound griefer live leaderboard message. */
export async function refreshGuildGrieferLeaderboard(
  client: Client,
  guildId: string,
): Promise<void> {
  const row = await prisma.guildConfig.findUnique({
    where: { guildId },
    select: {
      grieferLeaderboardChannelId: true,
      grieferLeaderboardMessageId: true,
      grieferLeaderboardSize: true,
      grieferLeaderboardDisplay: true,
      grieferLeaderboardSort: true,
    },
  });
  if (!row?.grieferLeaderboardChannelId || !row.grieferLeaderboardMessageId) {
    return;
  }

  const embeds = await buildLiveGrieferEmbeds(
    guildId,
    row.grieferLeaderboardSize ?? LIVE_LEADERBOARD_DEFAULT_SIZE,
    row.grieferLeaderboardDisplay ?? 'both',
    row.grieferLeaderboardSort ?? 'count',
  );

  try {
    const channel = await fetchTextChannel(client, row.grieferLeaderboardChannelId);
    await channel.messages.edit(row.grieferLeaderboardMessageId, { embeds });
  } catch (error) {
    log.warn({ err: error, guildId }, 'Griefer leaderboard edit failed; reposting');
    try {
      const channel = await fetchTextChannel(client, row.grieferLeaderboardChannelId);
      const message = await channel.send({ embeds });
      await setGrieferLeaderboardChannel(guildId, row.grieferLeaderboardChannelId, message.id);
    } catch (repostError) {
      log.warn({ err: repostError, guildId }, 'Griefer leaderboard repost failed');
    }
  }
}

/** Refresh every guild with a bound griefer live leaderboard. */
export async function refreshAllGrieferLeaderboardChannels(client: Client): Promise<void> {
  const guilds = await prisma.guildConfig.findMany({
    where: {
      grieferLeaderboardChannelId: { not: null },
      grieferLeaderboardMessageId: { not: null },
    },
    select: { guildId: true },
  });

  for (const guild of guilds) {
    await refreshGuildGrieferLeaderboard(client, guild.guildId);
  }
}
