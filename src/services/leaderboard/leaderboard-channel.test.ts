import { describe, expect, it, vi } from 'vitest';

const { leagueFindUnique, leagueFindMany } = vi.hoisted(() => ({
  leagueFindUnique: vi.fn(),
  leagueFindMany: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: {
      findUnique: leagueFindUnique,
      findMany: leagueFindMany,
    },
  },
}));

vi.mock('../league/league-wc3stats.js', () => ({
  setLeagueLeaderboardChannel: vi.fn(),
  clearLeagueLeaderboardChannel: vi.fn(),
}));

vi.mock('./leaderboard.js', () => ({
  loadOverallLeaderboardTop: vi.fn().mockResolvedValue([]),
  LIVE_LEADERBOARD_SIZE: 10,
}));

import { refreshLeagueLeaderboard } from './leaderboard-channel.js';

describe('refreshLeagueLeaderboard', () => {
  it('skips when league has no leaderboard channel', async () => {
    leagueFindUnique.mockResolvedValue({ leaderboardChannelId: null, leaderboardMessageId: null });
    const client = { channels: { fetch: vi.fn() } } as never;
    await refreshLeagueLeaderboard(client, 'league-1');
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it('skips channel fetch when message id is missing', async () => {
    leagueFindUnique.mockResolvedValue({
      leaderboardChannelId: 'channel-1',
      leaderboardMessageId: null,
    });
    const client = { channels: { fetch: vi.fn() } } as never;
    await refreshLeagueLeaderboard(client, 'league-1');
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });
});
