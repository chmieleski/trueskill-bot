import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import { notifyLeagueRatingChanged } from './notify-league-rating-changed.js';

const { markDirtyMock, refreshLeaderboardMock } = vi.hoisted(() => ({
  markDirtyMock: vi.fn(),
  refreshLeaderboardMock: vi.fn(),
}));

vi.mock('./mark-dirty.js', () => ({
  markLeagueHeroChampionRolesDirty: markDirtyMock,
}));

vi.mock('../leaderboard/leaderboard-channel.js', () => ({
  refreshLeagueLeaderboard: refreshLeaderboardMock,
}));

describe('notifyLeagueRatingChanged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks hero champion roles dirty and refreshes live leaderboard', async () => {
    const fakeClient = {} as Client;
    await notifyLeagueRatingChanged(fakeClient, 'league-123');

    expect(markDirtyMock).toHaveBeenCalledWith('league-123');
    expect(refreshLeaderboardMock).toHaveBeenCalledWith(fakeClient, 'league-123');
  });
});
