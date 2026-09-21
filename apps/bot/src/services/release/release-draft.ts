import type { Client, Message, TextChannel } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import {
  extractChangelogSection,
  isPlaceholderVersion,
  readAppVersion,
  readChangelogMarkdown,
} from './changelog.js';
import { findChangelogDraftChannel } from './release-config.js';
import { buildStaffReleaseButtons, buildStaffReleaseEmbed } from './release-embed.js';
import { PLAYER_NOTES_MAX } from './release-publish.js';

const log = createLogger('release-draft');

export async function ensureDraftForVersion(input: {
  version: string;
  changelogMarkdown: string;
}): Promise<'skipped_placeholder' | 'missing_notes' | 'exists' | 'created'> {
  if (isPlaceholderVersion(input.version)) {
    return 'skipped_placeholder';
  }

  const existing = await prisma.botRelease.findUnique({
    where: { version: input.version },
    select: { version: true },
  });
  if (existing) {
    return 'exists';
  }

  const notes = extractChangelogSection(input.changelogMarkdown, input.version);
  if (!notes) {
    return 'missing_notes';
  }

  await prisma.botRelease.create({
    data: {
      version: input.version,
      engineeringNotes: notes,
      playerNotes: notes.slice(0, PLAYER_NOTES_MAX),
      status: 'draft',
    },
  });
  return 'created';
}

/**
 * Open a draft for the on-disk version (if needed) and post missing staff cards.
 */
export async function syncCurrentReleaseDraft(client: Client, rootDir?: string): Promise<void> {
  let version: string;
  let changelogMarkdown: string;
  try {
    // Version lives on @dbz/bot; CHANGELOG.md stays at the monorepo root.
    version = rootDir ? readAppVersion(rootDir) : readAppVersion();
    changelogMarkdown = rootDir ? readChangelogMarkdown(rootDir) : readChangelogMarkdown();
  } catch (error) {
    log.error({ err: error }, 'Failed to read app version or changelog');
    return;
  }

  const result = await ensureDraftForVersion({ version, changelogMarkdown });
  if (result === 'missing_notes') {
    log.error({ version }, 'Changelog has no notes for this version');
  }

  await postPendingStaffCards(client);
}

/**
 * Create or refresh staff draft cards in the configured changelog draft channel.
 */
export async function postPendingStaffCards(client: Client): Promise<void> {
  const draftChannel = await findChangelogDraftChannel();
  if (!draftChannel) {
    return;
  }

  let channel;
  try {
    channel = await client.channels.fetch(draftChannel.channelId);
  } catch (error) {
    log.warn(
      { err: error, channelId: draftChannel.channelId },
      'Failed to fetch changelog draft channel',
    );
    return;
  }

  if (!channel || !channel.isTextBased()) {
    log.warn(
      { channelId: draftChannel.channelId },
      'Changelog draft channel is not a guild text channel',
    );
    return;
  }

  const textChannel = channel as TextChannel;
  const drafts = await prisma.botRelease.findMany({
    where: { status: 'draft' },
  });

  for (const draft of drafts) {
    try {
      const payload = {
        embeds: [
          buildStaffReleaseEmbed({
            version: draft.version,
            playerNotes: draft.playerNotes,
            engineeringNotes: draft.engineeringNotes,
            status: 'draft',
          }),
        ],
        components: buildStaffReleaseButtons(draft.version, 'draft'),
      };

      let message: Message;
      if (draft.draftMessageId) {
        try {
          message = await textChannel.messages.fetch(draft.draftMessageId);
          await message.edit(payload);
        } catch {
          message = await textChannel.send(payload);
        }
      } else {
        message = await textChannel.send(payload);
      }

      await prisma.botRelease.update({
        where: { version: draft.version },
        data: {
          draftGuildId: draftChannel.guildId,
          draftChannelId: draftChannel.channelId,
          draftMessageId: message.id,
        },
      });
    } catch (error) {
      log.warn(
        { err: error, version: draft.version, channelId: draftChannel.channelId },
        'Failed to post staff changelog card',
      );
    }
  }
}
