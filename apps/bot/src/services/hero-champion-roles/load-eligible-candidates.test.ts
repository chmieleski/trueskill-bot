import { beforeEach, describe, expect, it, vi } from 'vitest';

const { playerHeroRatingFindMany, loadMatchDisplayStats, gamesByPlayerFromStats } = vi.hoisted(
  () => ({
    playerHeroRatingFindMany: vi.fn(),
    loadMatchDisplayStats: vi.fn(),
    gamesByPlayerFromStats: vi.fn(),
  }),
);

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    playerHeroRating: { findMany: playerHeroRatingFindMany },
  },
}));

vi.mock('../rating/rank-reset-display.js', () => ({
  loadMatchDisplayStats,
  gamesByPlayerFromStats,
}));

vi.mock('../rating/rating-math.js', async () => {
  const actual = await vi.importActual<typeof import('../rating/rating-math.js')>(
    '../rating/rating-math.js',
  );
  return {
    ...actual,
  };
});

import { loadEligibleHeroCandidates } from './load-eligible-candidates.js';

describe('loadEligibleHeroCandidates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadMatchDisplayStats.mockResolvedValue({ byPlayer: new Map() });
    gamesByPlayerFromStats.mockReturnValue(
      new Map([
        ['p-few-hero', 10],
        ['p-enough-hero', 10],
        ['p-calibrating', 3],
        ['p-unlinked', 10],
      ]),
    );
  });

  it('requires at least 5 matches on that hero', async () => {
    playerHeroRatingFindMany.mockResolvedValue([
      {
        playerId: 'p-few-hero',
        mu: 30,
        sigma: 5,
        matchesPlayed: 4,
        player: { username: 'few', discordId: 'd-few' },
      },
      {
        playerId: 'p-enough-hero',
        mu: 28,
        sigma: 5,
        matchesPlayed: 5,
        player: { username: 'enough', discordId: 'd-enough' },
      },
      {
        playerId: 'p-calibrating',
        mu: 27,
        sigma: 5,
        matchesPlayed: 8,
        player: { username: 'cal', discordId: 'd-cal' },
      },
      {
        playerId: 'p-unlinked',
        mu: 29,
        sigma: 5,
        matchesPlayed: 9,
        player: { username: 'nolink', discordId: null },
      },
    ]);

    const candidates = await loadEligibleHeroCandidates('league-1', 1);

    expect(playerHeroRatingFindMany).toHaveBeenCalledWith({
      where: { leagueId: 'league-1', heroId: 1, matchesPlayed: { gte: 5 } },
      include: {
        player: { select: { username: true, discordId: true } },
      },
    });
    expect(candidates).toEqual([
      expect.objectContaining({ discordId: 'd-enough', username: 'enough' }),
    ]);
  });
});
