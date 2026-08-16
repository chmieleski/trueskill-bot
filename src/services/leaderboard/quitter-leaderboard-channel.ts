import type { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import {
  clearQuitterLeaderboardChannel,
  setQuitterLeaderboardChannel,
} from '../guild/guild-config.js';
import { LIVE_LEADERBOARD_DEFAULT_SIZE } from './leaderboard.js';
import {
  loadQuitterLeaderboardTop,
  type QuitterLeaderboardDisplayMode,
  type QuitterLeaderboardSortMode,
} from './quitter-leaderboard.js';
import { buildQuitterLiveLeaderboardEmbeds } from './quitter-leaderboard-embed.js';

const log = createLogger('quitter_leaderboard_channel');

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
    log.warn({ err: error, channelId, messageId }, 'Failed to delete quitter leaderboard message');
  }
}

async function buildLiveQuitterEmbeds(
  guildId: string,
  size?: number,
  display?: QuitterLeaderboardDisplayMode,
  sort?: QuitterLeaderboardSortMode,
): Promise<EmbedBuilder[]> {
  let resolvedSize = size;
  let resolvedDisplay = display;
  let resolvedSort = sort;

  if (
    resolvedSize === undefined ||
    resolvedDisplay === undefined ||
    resolvedSort === undefined
  ) {
    const row = await prisma.guildConfig.findUnique({
      where: { guildId },
      select: {
        quitterLeaderboardSize: true,
        quitterLeaderboardDisplay: true,
        quitterLeaderboardSort: true,
      },
    });
    resolvedSize = resolvedSize ?? row?.quitterLeaderboardSize ?? LIVE_LEADERBOARD_DEFAULT_SIZE;
    resolvedDisplay = resolvedDisplay ?? row?.quitterLeaderboardDisplay ?? 'both';
    resolvedSort = resolvedSort ?? row?.quitterLeaderboardSort ?? 'count';
  }

  const entries = await loadQuitterLeaderboardTop(
    guildId,
    resolvedSize,
    resolvedDisplay,
    resolvedSort,
  );
  return buildQuitterLiveLeaderboardEmbeds(
    entries,
    resolvedDisplay,
    resolvedSort,
    new Date(),
  );
}

/** Post a live quitter leaderboard message and bind it on GuildConfig. */
export async function setupQuitterLiveLeaderboard(
  client: Client,
  guildId: string,
  channelId: string,
): Promise<{ messageId: string }> {
  const existing = await prisma.guildConfig.findUnique({
    where: { guildId },
    select: {
      quitterLeaderboardChannelId: true,
      quitterLeaderboardMessageId: true,
      quitterLeaderboardSize: true,
      quitterLeaderboardDisplay: true,
      quitterLeaderboardSort: true,
    },
  });
  if (existing?.quitterLeaderboardMessageId && existing.quitterLeaderboardChannelId) {
    await deleteMessageBestEffort(
      client,
      existing.quitterLeaderboardChannelId,
      existing.quitterLeaderboardMessageId,
    );
  }

  const embeds = await buildLiveQuitterEmbeds(
    guildId,
    existing?.quitterLeaderboardSize ?? LIVE_LEADERBOARD_DEFAULT_SIZE,
    existing?.quitterLeaderboardDisplay ?? 'both',
    existing?.quitterLeaderboardSort ?? 'count',
  );
  const channel = await fetchTextChannel(client, channelId);
  const message = await channel.send({ embeds });

  await setQuitterLeaderboardChannel(guildId, channelId, message.id);

  return { messageId: message.id };
}

/** Delete the live quitter message (best-effort) and clear GuildConfig binding. */
export async function clearQuitterLiveLeaderboard(
  client: Client,
  guildId: string,
): Promise<void> {
  const row = await prisma.guildConfig.findUnique({
    where: { guildId },
    select: {
      quitterLeaderboardChannelId: true,
      quitterLeaderboardMessageId: true,
    },
  });
  if (row?.quitterLeaderboardChannelId && row.quitterLeaderboardMessageId) {
    await deleteMessageBestEffort(
      client,
      row.quitterLeaderboardChannelId,
      row.quitterLeaderboardMessageId,
    );
  }

  await clearQuitterLeaderboardChannel(guildId);
}

/** Edit (or repost) the guild's bound quitter live leaderboard message. */
export async function refreshGuildQuitterLeaderboard(
  client: Client,
  guildId: string,
): Promise<void> {
  const row = await prisma.guildConfig.findUnique({
    where: { guildId },
    select: {
      quitterLeaderboardChannelId: true,
      quitterLeaderboardMessageId: true,
      quitterLeaderboardSize: true,
      quitterLeaderboardDisplay: true,
      quitterLeaderboardSort: true,
    },
  });
  if (!row?.quitterLeaderboardChannelId || !row.quitterLeaderboardMessageId) {
    return;
  }

  const embeds = await buildLiveQuitterEmbeds(
    guildId,
    row.quitterLeaderboardSize ?? LIVE_LEADERBOARD_DEFAULT_SIZE,
    row.quitterLeaderboardDisplay ?? 'both',
    row.quitterLeaderboardSort ?? 'count',
  );

  try {
    const channel = await fetchTextChannel(client, row.quitterLeaderboardChannelId);
    await channel.messages.edit(row.quitterLeaderboardMessageId, { embeds });
  } catch (error) {
    log.warn({ err: error, guildId }, 'Quitter leaderboard edit failed; reposting');
    try {
      const channel = await fetchTextChannel(client, row.quitterLeaderboardChannelId);
      const message = await channel.send({ embeds });
      await setQuitterLeaderboardChannel(guildId, row.quitterLeaderboardChannelId, message.id);
    } catch (repostError) {
      log.warn({ err: repostError, guildId }, 'Quitter leaderboard repost failed');
    }
  }
}

/** Refresh every guild with a bound quitter live leaderboard. */
export async function refreshAllQuitterLeaderboardChannels(client: Client): Promise<void> {
  const guilds = await prisma.guildConfig.findMany({
    where: {
      quitterLeaderboardChannelId: { not: null },
      quitterLeaderboardMessageId: { not: null },
    },
    select: { guildId: true },
  });

  for (const guild of guilds) {
    await refreshGuildQuitterLeaderboard(client, guild.guildId);
  }
}
