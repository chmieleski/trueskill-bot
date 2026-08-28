import { MessageType, type Message, type TextChannel } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { isGuildLobbyChannel } from './league-lobby-channel.js';

const log = createLogger('league_channel_moderation');

const KEEP_MESSAGE_TYPES = new Set<MessageType>([
  MessageType.ChatInputCommand,
  MessageType.ContextMenuCommand,
]);

/** Parent category id when the channel is guild-scoped and categorized. */
export function getMessageCategoryId(message: Pick<Message, 'channel'>): string | null {
  const channel = message.channel;
  if (!channel || !('parentId' in channel)) {
    return null;
  }
  return channel.parentId;
}

/**
 * True when the channel is directly bound to a league in this guild (`/league bind` target).
 * Category bindings apply to every channel under that category.
 */
export async function isGuildLeagueCommandChannel(
  guildId: string,
  channelId: string,
  categoryId: string | null | undefined,
): Promise<boolean> {
  const direct = await prisma.leagueChannelBinding.findUnique({
    where: { discordId: channelId },
    include: { league: { select: { guildId: true } } },
  });
  if (direct?.kind === 'CHANNEL' && direct.league.guildId === guildId) {
    return true;
  }

  if (categoryId) {
    const category = await prisma.leagueChannelBinding.findUnique({
      where: { discordId: categoryId },
      include: { league: { select: { guildId: true } } },
    });
    if (category?.kind === 'CATEGORY' && category.league.guildId === guildId) {
      return true;
    }
  }

  return false;
}

/**
 * True when non-command chat should be removed: ready lobby channel or league command channel.
 */
export async function isGuildModeratedBotChannel(
  guildId: string,
  channelId: string,
  categoryId: string | null | undefined,
): Promise<boolean> {
  if (await isGuildLobbyChannel(guildId, channelId)) {
    return true;
  }
  return isGuildLeagueCommandChannel(guildId, channelId, categoryId);
}

/** Whether a guild message should be deleted (slash commands and this bot's posts are kept). */
export function shouldDeleteNonCommandMessage(input: {
  authorId: string;
  botUserId: string | undefined;
  messageType: MessageType;
}): boolean {
  if (input.botUserId && input.authorId === input.botUserId) {
    return false;
  }
  if (KEEP_MESSAGE_TYPES.has(input.messageType)) {
    return false;
  }
  return true;
}

/**
 * Best-effort delete of a non-command user message in a moderated channel.
 * No-op when the message should be kept or the channel is not moderated.
 */
export async function purgeNonCommandMessage(message: Message): Promise<void> {
  if (!message.guildId) {
    return;
  }

  if (
    !shouldDeleteNonCommandMessage({
      authorId: message.author.id,
      botUserId: message.client.user?.id,
      messageType: message.type,
    })
  ) {
    return;
  }

  const channelId = message.channelId;
  const categoryId = getMessageCategoryId(message);
  const moderated = await isGuildModeratedBotChannel(message.guildId, channelId, categoryId);
  if (!moderated) {
    return;
  }

  try {
    await message.delete();
    log.debug(
      { guildId: message.guildId, channelId, messageId: message.id, authorId: message.author.id },
      'Deleted non-command message in moderated channel',
    );
  } catch (error) {
    log.warn(
      {
        err: error,
        guildId: message.guildId,
        channelId,
        messageId: message.id,
      },
      'Failed to delete non-command message in moderated channel',
    );
  }
}

/** Narrow to guild text channels that receive user chat (excludes threads for v1). */
export function isModeratableGuildTextChannel(channel: Message['channel']): channel is TextChannel {
  return (
    channel !== null &&
    typeof channel === 'object' &&
    'isTextBased' in channel &&
    channel.isTextBased() === true &&
    'guild' in channel &&
    channel.guild !== null &&
    !('isThread' in channel && channel.isThread())
  );
}
