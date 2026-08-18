import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUniqueRelease, updateRelease, findUniquePost, createPost } = vi.hoisted(() => ({
  findUniqueRelease: vi.fn(),
  updateRelease: vi.fn(),
  findUniquePost: vi.fn(),
  createPost: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    botRelease: { findUnique: findUniqueRelease, update: updateRelease },
    botReleasePost: { findUnique: findUniquePost, create: createPost },
  },
}));

import { ReleaseServiceError } from './errors.js';
import {
  ALREADY_PUBLISHED,
  ALREADY_SKIPPED,
  EMPTY_PLAYER_NOTES,
  PLAYER_NOTES_TOO_LONG,
  assertCanPublish,
  dismissRelease,
  markReleasePublished,
  recordReleasePost,
  savePlayerNotes,
} from './release-publish.js';

const POST_INPUT = {
  version: '1.0.0',
  guildId: 'guild-1',
  channelId: 'channel-1',
  messageId: 'message-1',
};

describe('assertCanPublish', () => {
  it('throws EMPTY_PLAYER_NOTES when notes are whitespace', () => {
    expect(() => assertCanPublish({ status: 'draft', playerNotes: '  ' })).toThrow(
      ReleaseServiceError,
    );
    expect(() => assertCanPublish({ status: 'draft', playerNotes: '  ' })).toThrow(
      EMPTY_PLAYER_NOTES,
    );
  });

  it('throws ALREADY_PUBLISHED when status is published', () => {
    expect(() =>
      assertCanPublish({ status: 'published', playerNotes: 'Notes' }),
    ).toThrow(ReleaseServiceError);
    expect(() =>
      assertCanPublish({ status: 'published', playerNotes: 'Notes' }),
    ).toThrow(ALREADY_PUBLISHED);
  });

  it('throws ALREADY_SKIPPED when status is skipped', () => {
    expect(() => assertCanPublish({ status: 'skipped', playerNotes: 'Notes' })).toThrow(
      ReleaseServiceError,
    );
    expect(() => assertCanPublish({ status: 'skipped', playerNotes: 'Notes' })).toThrow(
      ALREADY_SKIPPED,
    );
  });

  it('does not throw for a draft with notes', () => {
    expect(() =>
      assertCanPublish({ status: 'draft', playerNotes: 'Player-facing notes' }),
    ).not.toThrow();
  });

  it('does not throw for a draft with 4000-character notes', () => {
    expect(() =>
      assertCanPublish({ status: 'draft', playerNotes: 'x'.repeat(4000) }),
    ).not.toThrow();
  });

  it('throws when trimmed player notes exceed 4000 characters', () => {
    expect(() =>
      assertCanPublish({ status: 'draft', playerNotes: 'x'.repeat(4001) }),
    ).toThrow(ReleaseServiceError);
    expect(() =>
      assertCanPublish({ status: 'draft', playerNotes: 'x'.repeat(4001) }),
    ).toThrow(PLAYER_NOTES_TOO_LONG);
  });
});

describe('recordReleasePost', () => {
  beforeEach(() => {
    findUniquePost.mockReset();
    createPost.mockReset();
  });

  it('returns inserted on first call and exists on a later find', async () => {
    findUniquePost.mockResolvedValueOnce(null).mockResolvedValueOnce({ version: '1.0.0' });
    createPost.mockResolvedValue({});

    await expect(recordReleasePost(POST_INPUT)).resolves.toBe('inserted');
    await expect(recordReleasePost(POST_INPUT)).resolves.toBe('exists');
    expect(createPost).toHaveBeenCalledTimes(1);
    expect(createPost).toHaveBeenCalledWith({ data: POST_INPUT });
    expect(findUniquePost).toHaveBeenCalledWith({
      where: { version_guildId: { version: '1.0.0', guildId: 'guild-1' } },
      select: { version: true },
    });
  });
});

describe('savePlayerNotes', () => {
  beforeEach(() => {
    updateRelease.mockReset();
  });

  it('trims notes, allows empty, and caps at 4000 characters', async () => {
    updateRelease.mockResolvedValue({});

    await savePlayerNotes('1.0.0', '  hello  ');
    expect(updateRelease).toHaveBeenCalledWith({
      where: { version: '1.0.0' },
      data: { playerNotes: 'hello' },
    });

    await savePlayerNotes('1.0.0', '   ');
    expect(updateRelease).toHaveBeenCalledWith({
      where: { version: '1.0.0' },
      data: { playerNotes: '' },
    });

    const over = 'x'.repeat(4001);
    await savePlayerNotes('1.0.0', over);
    expect(updateRelease).toHaveBeenCalledWith({
      where: { version: '1.0.0' },
      data: { playerNotes: 'x'.repeat(4000) },
    });
  });
});

describe('markReleasePublished', () => {
  beforeEach(() => {
    updateRelease.mockReset();
  });

  it('sets published status and publishedAt', async () => {
    updateRelease.mockResolvedValue({});
    await markReleasePublished('1.0.0');
    expect(updateRelease).toHaveBeenCalledWith({
      where: { version: '1.0.0' },
      data: { status: 'published', publishedAt: expect.any(Date) },
    });
  });
});

describe('dismissRelease', () => {
  beforeEach(() => {
    findUniqueRelease.mockReset();
    updateRelease.mockReset();
    createPost.mockReset();
  });

  it('updates status to skipped and does not create posts', async () => {
    findUniqueRelease.mockResolvedValue({ status: 'draft' });
    updateRelease.mockResolvedValue({});

    await dismissRelease('1.0.0');

    expect(updateRelease).toHaveBeenCalledWith({
      where: { version: '1.0.0' },
      data: { status: 'skipped' },
    });
    expect(createPost).not.toHaveBeenCalled();
  });

  it('throws when the version is already published or skipped', async () => {
    findUniqueRelease.mockResolvedValue({ status: 'published' });
    await expect(dismissRelease('1.0.0')).rejects.toBeInstanceOf(ReleaseServiceError);
    await expect(dismissRelease('1.0.0')).rejects.toThrow(ALREADY_PUBLISHED);
    expect(updateRelease).not.toHaveBeenCalled();

    findUniqueRelease.mockResolvedValue({ status: 'skipped' });
    await expect(dismissRelease('1.0.0')).rejects.toThrow(ALREADY_SKIPPED);
    expect(updateRelease).not.toHaveBeenCalled();
  });
});
