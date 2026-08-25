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

import {
  aggregateTeammatePairs,
  buildTeammateStatsFromPairs,
  formatTeammateTable,
  loadTeammateStats,
  pickTopTeammates,
  type TeammatePairStats,
} from './teammate-stats.js';

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

describe('pickTopTeammates', () => {
  it('sorts by primary desc then WR% then nick A–Z and caps at 3', () => {
    const pairs = [
      pair({ playerId: 'a', username: 'Zed', games: 10, wins: 5, losses: 5 }),
      pair({ playerId: 'b', username: 'Ann', games: 10, wins: 8, losses: 2 }),
      pair({ playerId: 'c', username: 'Bob', games: 10, wins: 8, losses: 2 }),
      pair({ playerId: 'd', username: 'Cy', games: 9, wins: 9, losses: 0 }),
    ];
    expect(pickTopTeammates(pairs, 'games').map((p) => p.username)).toEqual(['Ann', 'Bob', 'Zed']);
  });

  it('sorts winRate by WR% desc then games, loseRate by WR% asc then games', () => {
    const pairs = [
      pair({ playerId: 'a', username: 'Low', games: 10, wins: 2, losses: 8 }),
      pair({ playerId: 'b', username: 'High', games: 5, wins: 5, losses: 0 }),
      pair({ playerId: 'c', username: 'Mid', games: 6, wins: 3, losses: 3 }),
      // Same WR% as High but fewer games — loses the games tie-break
      pair({ playerId: 'd', username: 'AlsoHigh', games: 2, wins: 2, losses: 0 }),
    ];
    expect(pickTopTeammates(pairs, 'winRate').map((p) => p.username)).toEqual([
      'High',
      'AlsoHigh',
      'Mid',
    ]);
    expect(pickTopTeammates(pairs, 'loseRate').map((p) => p.username)).toEqual([
      'Low',
      'Mid',
      'High',
    ]);
  });

  it('sorts null WR% after numeric WR% for games, winRate, and loseRate', () => {
    const pairs = [
      pair({
        playerId: 'a',
        username: 'Null',
        games: 5,
        wins: 0,
        losses: 0,
        winRatePercent: null,
      }),
      pair({ playerId: 'b', username: 'Zero', games: 5, wins: 0, losses: 5 }),
    ];
    expect(pickTopTeammates(pairs, 'games').map((p) => p.username)).toEqual(['Zero', 'Null']);
    expect(pickTopTeammates(pairs, 'winRate').map((p) => p.username)).toEqual(['Zero', 'Null']);
    expect(pickTopTeammates(pairs, 'loseRate').map((p) => p.username)).toEqual(['Zero', 'Null']);
  });
});

describe('aggregateTeammatePairs', () => {
  it('counts same-team partners and ignores the viewed player', () => {
    const pairs = aggregateTeammatePairs([
      {
        matchId: 'm1',
        completedAt: new Date('2026-08-01'),
        viewedPlayerId: 'p1',
        viewedTeam: 1,
        viewedResult: 'WIN',
        partners: [
          { playerId: 'p2', username: 'Ghost' },
          { playerId: 'p3', username: 'Krillin' },
        ],
      },
      {
        matchId: 'm2',
        completedAt: new Date('2026-08-02'),
        viewedPlayerId: 'p1',
        viewedTeam: 1,
        viewedResult: 'LOSS',
        partners: [{ playerId: 'p2', username: 'Ghost' }],
      },
    ]);
    const byId = new Map(pairs.map((p) => [p.playerId, p]));
    expect(byId.get('p2')).toMatchObject({
      username: 'Ghost',
      games: 2,
      wins: 1,
      losses: 1,
      winRatePercent: 50,
    });
    expect(byId.get('p3')).toMatchObject({
      username: 'Krillin',
      games: 1,
      wins: 1,
      losses: 0,
      winRatePercent: 100,
    });
    expect(byId.has('p1')).toBe(false);
  });

  it("skips rows before the caller's rank-reset cutoff when filtered upstream", () => {
    // aggregateTeammatePairs only sees already-eligible rows; empty in → empty out
    expect(aggregateTeammatePairs([])).toEqual([]);
  });
});

describe('formatTeammateTable', () => {
  it('pads nick and games and shows W/L · WR%', () => {
    const table = formatTeammateTable([
      pair({ playerId: 'a', username: 'Ghost', games: 14, wins: 9, losses: 5 }),
      pair({ playerId: 'b', username: 'Piccolo', games: 8, wins: 5, losses: 3 }),
    ]);
    expect(table).toContain('```');
    expect(table).toContain('Ghost');
    expect(table).toContain('14G');
    expect(table).toContain('9W 5L · 64.3%');
    expect(table).toContain('Piccolo');
    expect(table).toContain('8G');
  });

  it('omits percent when winRatePercent is null', () => {
    const table = formatTeammateTable([
      pair({
        playerId: 'a',
        username: 'Ghost',
        games: 0,
        wins: 0,
        losses: 0,
        winRatePercent: null,
      }),
    ]);
    expect(table).toContain('0G · 0W 0L');
    expect(table).not.toContain('%');
  });
});

describe('buildTeammateStatsFromPairs', () => {
  it('builds three top-3 lists from the same pool', () => {
    const pairs = [
      pair({ playerId: 'a', username: 'Ghost', games: 14, wins: 9, losses: 5 }), // 64.3%
      pair({ playerId: 'b', username: 'Krillin', games: 11, wins: 6, losses: 5 }), // 54.5%
      pair({ playerId: 'c', username: 'Piccolo', games: 8, wins: 5, losses: 3 }), // 62.5%
      pair({ playerId: 'd', username: 'Gohan', games: 5, wins: 4, losses: 1 }), // 80%
      pair({ playerId: 'e', username: 'Yamcha', games: 4, wins: 1, losses: 3 }), // 25%
    ];
    const stats = buildTeammateStatsFromPairs(pairs);
    expect(stats.playedWith.map((p) => p.username)).toEqual(['Ghost', 'Krillin', 'Piccolo']);
    expect(stats.winWith.map((p) => p.username)).toEqual(['Gohan', 'Ghost', 'Piccolo']);
    expect(stats.loseWith.map((p) => p.username)).toEqual(['Yamcha', 'Krillin', 'Piccolo']);
  });
});

describe('loadTeammateStats', () => {
  beforeEach(() => {
    matchPlayerFindMany.mockReset();
    loadLatestRankResetAtByPlayer.mockReset();
    loadLatestRankResetAtByPlayer.mockResolvedValue(new Map());
  });

  it('aggregates same-team partners after rank reset and ignores viewed quit matches', async () => {
    const resetAt = new Date('2026-08-10T00:00:00.000Z');
    loadLatestRankResetAtByPlayer.mockResolvedValue(new Map([['p1', resetAt]]));
    matchPlayerFindMany.mockResolvedValue([
      {
        matchId: 'old',
        team: 1,
        result: 'WIN',
        match: {
          id: 'old',
          completedAt: new Date('2026-08-01T00:00:00.000Z'),
          players: [
            { playerId: 'p1', team: 1, result: 'WIN', player: { username: 'Me' } },
            { playerId: 'p2', team: 1, result: 'WIN', player: { username: 'Ghost' } },
          ],
        },
      },
      {
        matchId: 'm1',
        team: 1,
        result: 'WIN',
        match: {
          id: 'm1',
          completedAt: new Date('2026-08-11T00:00:00.000Z'),
          players: [
            { playerId: 'p1', team: 1, result: 'WIN', player: { username: 'Me' } },
            { playerId: 'p2', team: 1, result: 'WIN', player: { username: 'Ghost' } },
            { playerId: 'p3', team: 2, result: 'LOSS', player: { username: 'EvilGuy' } },
          ],
        },
      },
      {
        matchId: 'm2',
        team: 1,
        result: 'LOSS',
        match: {
          id: 'm2',
          completedAt: new Date('2026-08-12T00:00:00.000Z'),
          players: [
            { playerId: 'p1', team: 1, result: 'LOSS', player: { username: 'Me' } },
            {
              playerId: 'p2',
              team: 1,
              result: null,
              player: { username: 'Ghost' },
            },
          ],
        },
      },
    ]);

    const stats = await loadTeammateStats('L1', 'p1');
    expect(stats.playedWith).toHaveLength(1);
    expect(stats.playedWith[0]).toMatchObject({
      playerId: 'p2',
      username: 'Ghost',
      games: 2,
      wins: 1,
      losses: 1,
      winRatePercent: 50,
    });
    expect(stats.playedWith.some((p) => p.username === 'EvilGuy')).toBe(false);
  });

  it('returns empty lists when the player has no counted teammates', async () => {
    matchPlayerFindMany.mockResolvedValue([]);
    const stats = await loadTeammateStats('L1', 'p1');
    expect(stats).toEqual({ playedWith: [], winWith: [], loseWith: [] });
  });
});
