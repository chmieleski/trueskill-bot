import { beforeEach, describe, expect, it, vi } from 'vitest';

const { matchPlayerFindMany, loadLatestRankResetAtByPlayer } = vi.hoisted(() => ({
  matchPlayerFindMany: vi.fn(),
  loadLatestRankResetAtByPlayer: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    matchPlayer: {
      findMany: matchPlayerFindMany,
    },
  },
}));

vi.mock('../rating/rank-reset-display.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rating/rank-reset-display.js')>();
  return {
    ...actual,
    loadLatestRankResetAtByPlayer,
  };
});

import { buildOpponentStatsFromPairs, loadOpponentStats } from './opponent-stats.js';
import type { TeammatePairStats } from './teammate-stats.js';

function pair(
  partial: Partial<TeammatePairStats> & Pick<TeammatePairStats, 'playerId' | 'username'>,
): TeammatePairStats {
  const wins = partial.wins ?? 0;
  const losses = partial.losses ?? 0;
  const games = partial.games ?? wins + losses;
  return {
    playerId: partial.playerId,
    username: partial.username,
    games,
    wins,
    losses,
    winRatePercent:
      partial.winRatePercent !== undefined
        ? partial.winRatePercent
        : games === 0
          ? null
          : Math.round((wins / games) * 1000) / 10,
  };
}

describe('buildOpponentStatsFromPairs', () => {
  it('maps played/win/lose lists to against field names', () => {
    const pairs = [
      pair({ playerId: 'a', username: 'Rival', games: 10, wins: 7, losses: 3 }),
      pair({ playerId: 'b', username: 'Boss', games: 6, wins: 2, losses: 4 }),
    ];
    const stats = buildOpponentStatsFromPairs(pairs);
    expect(stats.playedAgainst.map((p) => p.username)).toEqual(['Rival', 'Boss']);
    expect(stats.winAgainst.map((p) => p.username)).toEqual(['Rival', 'Boss']);
    expect(stats.loseAgainst.map((p) => p.username)).toEqual(['Boss', 'Rival']);
  });
});

describe('loadOpponentStats', () => {
  beforeEach(() => {
    matchPlayerFindMany.mockReset();
    loadLatestRankResetAtByPlayer.mockReset();
    loadLatestRankResetAtByPlayer.mockResolvedValue(new Map());
  });

  it('aggregates opposite-team opponents after rank reset', async () => {
    matchPlayerFindMany.mockResolvedValue([
      {
        matchId: 'm1',
        team: 1,
        result: 'WIN',
        match: {
          id: 'm1',
          completedAt: new Date('2026-08-20T00:00:00.000Z'),
          players: [
            { playerId: 'p1', team: 1, result: 'WIN', player: { username: 'Me' } },
            { playerId: 'p2', team: 1, result: 'WIN', player: { username: 'Ally' } },
            { playerId: 'p3', team: 2, result: 'LOSS', player: { username: 'Rival' } },
          ],
        },
      },
      {
        matchId: 'm2',
        team: 1,
        result: 'LOSS',
        match: {
          id: 'm2',
          completedAt: new Date('2026-08-21T00:00:00.000Z'),
          players: [
            { playerId: 'p1', team: 1, result: 'LOSS', player: { username: 'Me' } },
            { playerId: 'p3', team: 2, result: 'WIN', player: { username: 'Rival' } },
          ],
        },
      },
    ]);

    const stats = await loadOpponentStats('L1', 'p1');
    expect(stats.playedAgainst).toHaveLength(1);
    expect(stats.playedAgainst[0]).toMatchObject({
      playerId: 'p3',
      username: 'Rival',
      games: 2,
      wins: 1,
      losses: 1,
      winRatePercent: 50,
    });
    expect(stats.playedAgainst.some((p) => p.username === 'Ally')).toBe(false);
  });

  it('returns empty lists when the player has no counted opponents', async () => {
    matchPlayerFindMany.mockResolvedValue([]);
    const stats = await loadOpponentStats('L1', 'p1');
    expect(stats).toEqual({ playedAgainst: [], winAgainst: [], loseAgainst: [] });
  });
});
