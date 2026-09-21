import { prisma } from '../../lib/prisma.js';
import { ReleaseServiceError } from './errors.js';

export const EMPTY_PLAYER_NOTES =
  'Write player notes before publishing. Use Dismiss if this version should not be announced.';
export const PLAYER_NOTES_TOO_LONG =
  'Player notes must be 4000 characters or fewer. Edit the notes and try again.';
export const ALREADY_PUBLISHED = 'This version is already published.';
export const ALREADY_SKIPPED = 'This version was dismissed.';

export const PLAYER_NOTES_MAX = 4000;

/**
 * Refuse Publish when the version is already closed, notes are empty, or notes exceed the embed cap.
 */
export function assertCanPublish(release: {
  status: 'draft' | 'published' | 'skipped';
  playerNotes: string;
}): void {
  if (release.status === 'published') {
    throw new ReleaseServiceError(ALREADY_PUBLISHED);
  }
  if (release.status === 'skipped') {
    throw new ReleaseServiceError(ALREADY_SKIPPED);
  }
  const notes = release.playerNotes.trim();
  if (notes === '') {
    throw new ReleaseServiceError(EMPTY_PLAYER_NOTES);
  }
  if (notes.length > PLAYER_NOTES_MAX) {
    throw new ReleaseServiceError(PLAYER_NOTES_TOO_LONG);
  }
}

/**
 * Persist staff-edited player notes. Empty is allowed so Dismiss still works.
 */
export async function savePlayerNotes(version: string, playerNotes: string): Promise<void> {
  const trimmed = playerNotes.trim().slice(0, PLAYER_NOTES_MAX);
  await prisma.botRelease.update({
    where: { version },
    data: { playerNotes: trimmed },
  });
}

/**
 * Record a successful player-channel post. Returns `exists` when this guild already has one.
 */
export async function recordReleasePost(input: {
  version: string;
  guildId: string;
  channelId: string;
  messageId: string;
}): Promise<'inserted' | 'exists'> {
  const existing = await prisma.botReleasePost.findUnique({
    where: { version_guildId: { version: input.version, guildId: input.guildId } },
    select: { version: true },
  });
  if (existing) {
    return 'exists';
  }
  await prisma.botReleasePost.create({ data: input });
  return 'inserted';
}

/** Mark the version published after fan-out (caller posts to Discord). */
export async function markReleasePublished(version: string): Promise<void> {
  await prisma.botRelease.update({
    where: { version },
    data: { status: 'published', publishedAt: new Date() },
  });
}

/** Close a draft without posting player notes. */
export async function dismissRelease(version: string): Promise<void> {
  const row = await prisma.botRelease.findUnique({
    where: { version },
    select: { status: true },
  });
  if (row?.status === 'published') {
    throw new ReleaseServiceError(ALREADY_PUBLISHED);
  }
  if (row?.status === 'skipped') {
    throw new ReleaseServiceError(ALREADY_SKIPPED);
  }

  await prisma.botRelease.update({
    where: { version },
    data: { status: 'skipped' },
  });
}
