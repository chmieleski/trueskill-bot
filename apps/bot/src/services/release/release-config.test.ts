import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findFirst, findMany, upsert } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    guildConfig: { findFirst, findMany, upsert },
  },
}));

import { DRAFT_CHANNEL_TAKEN, setChangelogDraftChannel } from './release-config.js';
import { ReleaseServiceError } from './errors.js';

describe('setChangelogDraftChannel', () => {
  beforeEach(() => {
    findFirst.mockReset();
    upsert.mockReset();
  });

  it('rejects when another guild already has a draft channel', async () => {
    findFirst.mockResolvedValue({ guildId: 'other', changelogDraftChannelId: 'ch-1' });
    await expect(setChangelogDraftChannel('guild-2', 'ch-2')).rejects.toBeInstanceOf(
      ReleaseServiceError,
    );
    await expect(setChangelogDraftChannel('guild-2', 'ch-2')).rejects.toThrow(DRAFT_CHANNEL_TAKEN);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('allows the same guild to change its draft channel', async () => {
    findFirst.mockResolvedValue(null);
    upsert.mockResolvedValue({});
    await setChangelogDraftChannel('guild-1', 'ch-9');
    expect(upsert).toHaveBeenCalled();
  });
});
