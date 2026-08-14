import { describe, expect, it, vi } from 'vitest';

const { findUnique, findMany, upsert } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    guildConfig: { findUnique, findMany, upsert },
  },
}));

vi.mock('./guild-config.js', () => ({
  setLeaderboardChannel: vi.fn(),
  clearLeaderboardChannel: vi.fn(),
}));

vi.mock('./leaderboard.js', () => ({
  loadOverallLeaderboardTop: vi.fn().mockResolvedValue([]),
  LIVE_LEADERBOARD_SIZE: 10,
}));

import { refreshGuildLeaderboard } from './leaderboard-channel.js';

describe('refreshGuildLeaderboard', () => {
  it('skips when config is incomplete', async () => {
    findUnique.mockResolvedValue({ guildId: 'g1', leaderboardChannelId: null });
    const client = { channels: { fetch: vi.fn() } } as never;
    await refreshGuildLeaderboard(client, 'g1');
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });
});
