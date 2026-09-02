import type { CaptainDraft, Prisma } from '@prisma/client';
import type { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { buildLiveDraftMessage } from './draft-live-embed.js';
import { currentCaptainKey, findParticipant, isDraftComplete } from './draft-logic.js';
import { buildTeamRosterEmbeds } from './draft-team-embed.js';
import { parseDraftState, saveDraftState } from './draft-state.js';
import type { CaptainDraftStatus, DraftState } from './draft-types.js';

const log = createLogger('captain_draft_display');
const MAX_EMBEDS_PER_MESSAGE = 10;

async function fetchTextChannel(client: Client, channelId: string): Promise<TextChannel> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    throw new Error(`Channel ${channelId} is not a guild text channel`);
  }
  return channel as TextChannel;
}

function chunkEmbeds(embeds: EmbedBuilder[]): EmbedBuilder[][] {
  if (embeds.length === 0) {
    return [[]];
  }

  const chunks: EmbedBuilder[][] = [];
  for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
    chunks.push(embeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE));
  }
  return chunks;
}

function parseMessageIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function serializeMessageIds(messageIds: string[]): Prisma.InputJsonValue {
  return messageIds as unknown as Prisma.InputJsonValue;
}

async function upsertDraftDisplay(
  draftId: string,
  channelId: string,
  messageIds: string[],
): Promise<void> {
  await prisma.captainDraftDisplay.upsert({
    where: { draftId },
    create: {
      draftId,
      channelId,
      messageIds: serializeMessageIds(messageIds),
    },
    update: {
      channelId,
      messageIds: serializeMessageIds(messageIds),
    },
  });
}

async function sendEmbedChunks(
  channel: TextChannel,
  embedChunks: EmbedBuilder[][],
): Promise<string[]> {
  const messageIds: string[] = [];
  for (const embeds of embedChunks) {
    const message = await channel.send({ embeds });
    messageIds.push(message.id);
  }
  return messageIds;
}

async function syncEmbedChunks(
  client: Client,
  channelId: string,
  storedMessageIds: string[],
  embedChunks: EmbedBuilder[][],
): Promise<string[]> {
  const channel = await fetchTextChannel(client, channelId);
  const nextMessageIds: string[] = [];

  for (let i = 0; i < embedChunks.length; i += 1) {
    const embeds = embedChunks[i]!;
    const messageId = storedMessageIds[i];

    if (messageId) {
      try {
        await channel.messages.edit(messageId, { embeds });
        nextMessageIds.push(messageId);
        continue;
      } catch (error) {
        log.warn(
          { err: error, channelId, messageId },
          'Draft display edit failed; reposting chunk',
        );
      }
    }

    try {
      const message = await channel.send({ embeds });
      nextMessageIds.push(message.id);
    } catch (error) {
      log.warn({ err: error, channelId }, 'Draft display repost failed');
    }
  }

  for (let i = embedChunks.length; i < storedMessageIds.length; i += 1) {
    const staleId = storedMessageIds[i];
    if (!staleId) continue;
    try {
      await channel.messages.delete(staleId);
    } catch (error) {
      log.warn(
        { err: error, channelId, messageId: staleId },
        'Failed to delete stale draft message',
      );
    }
  }

  return nextMessageIds;
}

export type SyncLiveDraftMessageOptions = {
  /** Draft state before the update; when the on-clock captain changes, a separate ping is sent. */
  previousState?: DraftState;
};

/**
 * Send a Discord notification when the on-clock captain changes.
 * Edits to the live draft card do not re-trigger mentions, so turn changes need a new message.
 */
export async function notifyOnClockCaptainIfChanged(
  client: Client,
  draft: CaptainDraft,
  previousState?: DraftState,
): Promise<void> {
  const status = draft.status as CaptainDraftStatus;
  if (status !== 'ACTIVE' || !previousState) {
    return;
  }

  const state = parseDraftState(draft);
  if (isDraftComplete(state)) {
    return;
  }

  const previousCaptainKey = currentCaptainKey(previousState);
  const currentCaptainKeyValue = currentCaptainKey(state);
  if (!currentCaptainKeyValue || currentCaptainKeyValue === previousCaptainKey) {
    return;
  }

  const captain = findParticipant(state, currentCaptainKeyValue);
  if (!captain?.discordId) {
    return;
  }

  const content = `<@${captain.discordId}> — your turn to pick!`;

  try {
    const channel = await fetchTextChannel(client, draft.channelId);
    await channel.send({
      content,
      allowedMentions: { users: [captain.discordId] },
    });
  } catch (error) {
    log.warn({ err: error, draftId: draft.id }, 'Failed to ping on-clock captain');
  }
}

/** Re-edit the live draft message in the draft channel, or repost on failure. */
export async function syncLiveDraftMessage(
  client: Client,
  draft: CaptainDraft,
  options?: SyncLiveDraftMessageOptions,
): Promise<void> {
  if (!draft.draftMessageId) {
    return;
  }

  const state = parseDraftState(draft);
  const status = draft.status as CaptainDraftStatus;
  const messagePayload = buildLiveDraftMessage(draft.id, state, status);

  try {
    const channel = await fetchTextChannel(client, draft.channelId);
    await channel.messages.edit(draft.draftMessageId, messagePayload);
    await notifyOnClockCaptainIfChanged(client, draft, options?.previousState);
  } catch (error) {
    log.warn({ err: error, draftId: draft.id }, 'Live draft edit failed; reposting');
    try {
      const channel = await fetchTextChannel(client, draft.channelId);
      const message = await channel.send(messagePayload);
      await saveDraftState(draft.id, status, state, { draftMessageId: message.id });
    } catch (repostError) {
      log.warn({ err: repostError, draftId: draft.id }, 'Live draft repost failed');
    }
  }
}

/** Publish or refresh team roster embeds in the target channel (max 10 embeds per message). */
export async function publishTeamRosters(
  client: Client,
  draft: CaptainDraft,
  channel: TextChannel,
): Promise<void> {
  const state = parseDraftState(draft);
  const completedAt = draft.updatedAt;
  const embeds = buildTeamRosterEmbeds(state, completedAt);
  const embedChunks = chunkEmbeds(embeds);

  const existing = await prisma.captainDraftDisplay.findUnique({
    where: { draftId: draft.id },
  });

  const storedIds = parseMessageIds(existing?.messageIds);
  const sameChannel = existing?.channelId === channel.id;
  const messageIds =
    existing && sameChannel && storedIds.length > 0
      ? await syncEmbedChunks(client, channel.id, storedIds, embedChunks)
      : await sendEmbedChunks(channel, embedChunks);

  await upsertDraftDisplay(draft.id, channel.id, messageIds);
}

/** Refresh published team embeds when a display record exists. */
export async function refreshPublishedTeamsIfAny(
  client: Client,
  draft: CaptainDraft,
): Promise<void> {
  const display = await prisma.captainDraftDisplay.findUnique({
    where: { draftId: draft.id },
  });
  if (!display) {
    return;
  }

  try {
    const channel = await fetchTextChannel(client, display.channelId);
    await publishTeamRosters(client, draft, channel);
  } catch (error) {
    log.warn({ err: error, draftId: draft.id }, 'Failed to refresh published team rosters');
  }
}
