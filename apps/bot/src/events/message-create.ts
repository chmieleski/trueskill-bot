import { Events } from 'discord.js';
import type { Message } from 'discord.js';
import { createLogger } from '../lib/logger.js';
import {
  isModeratableGuildTextChannel,
  purgeNonCommandMessage,
} from '../services/league/league-channel-moderation.js';

const log = createLogger('message_create');

export const name = Events.MessageCreate;

export async function execute(message: Message): Promise<void> {
  if (message.author.id === message.client.user?.id) {
    return;
  }

  if (!isModeratableGuildTextChannel(message.channel)) {
    return;
  }

  log.verbose(
    {
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author.id,
      messageType: message.type,
    },
    'Message received',
  );

  await purgeNonCommandMessage(message);
}
