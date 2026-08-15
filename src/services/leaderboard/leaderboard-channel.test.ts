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
  LIVE_LEADERBOARD_DEFAULT_SIZE: 10,
}));

vi.mock('./leaderboard-embed.js', () => ({
  buildOverallLiveLeaderboardEmbeds: vi.fn().mockReturnValue([{ fake: true }]),
}));

import { buildOverallLiveLeaderboardEmbeds } from './leaderboard-embed.js';
import { loadOverallLeaderboardTop } from './leaderboard.js';
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

  it('edits message with embeds array when bound', async () => {
    leagueFindUnique.mockResolvedValue({
      leaderboardChannelId: 'channel-1',
      leaderboardMessageId: 'msg-1',
      leaderboardSize: 50,
    });
    const edit = vi.fn().mockResolvedValue(undefined);
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          isDMBased: () => false,
          messages: { edit, delete: vi.fn() },
        }),
      },
    } as never;

    await refreshLeagueLeaderboard(client, 'league-1');

    expect(loadOverallLeaderboardTop).toHaveBeenCalledWith('league-1', 50);
    expect(buildOverallLiveLeaderboardEmbeds).toHaveBeenCalled();
    expect(edit).toHaveBeenCalledWith('msg-1', {
      embeds: [{ fake: true }],
    });
  });
});
