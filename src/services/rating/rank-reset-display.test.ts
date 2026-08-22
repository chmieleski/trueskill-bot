import { describe, expect, it } from 'vitest';
import { MatchResult } from '@prisma/client';
import {
  aggregateHeroMatchDisplayStats,
  aggregateMatchDisplayStats,
  countCompletedGamesThrough,
  gamesByPlayerFromStats,
  habitualQuitterFromStats,
  heroStatsFor,
  isHabitualQuitter,
  isMatchCountedAfterRankReset,
  winRatePercent,
} from './rank-reset-display.js';

const RESET = new Date('2026-08-10T12:00:00.000Z');
const BEFORE = new Date('2026-08-01T12:00:00.000Z');
const AFTER = new Date('2026-08-12T12:00:00.000Z');

describe('isMatchCountedAfterRankReset', () => {
  it('counts every match when the player has never reset', () => {
    expect(isMatchCountedAfterRankReset(BEFORE, undefined)).toBe(true);
    expect(isMatchCountedAfterRankReset(null, undefined)).toBe(true);
  });

  it('counts only matches completed strictly after the reset', () => {
    expect(isMatchCountedAfterRankReset(AFTER, RESET)).toBe(true);
    expect(isMatchCountedAfterRankReset(RESET, RESET)).toBe(false);
    expect(isMatchCountedAfterRankReset(BEFORE, RESET)).toBe(false);
  });

  it('excludes matches with no completedAt after a reset', () => {
    expect(isMatchCountedAfterRankReset(null, RESET)).toBe(false);
  });
});

describe('countCompletedGamesThrough', () => {
  const playerId = 'p1';

  it('counts WIN/LOSS rows through the given completion time', () => {
    const count = countCompletedGamesThrough(
      [
        {
          playerId,
          result: MatchResult.WIN,
          completedAt: new Date('2026-08-01T12:00:00.000Z'),
        },
        {
          playerId,
          result: MatchResult.LOSS,
          completedAt: new Date('2026-08-05T12:00:00.000Z'),
        },
        {
          playerId,
          result: MatchResult.WIN,
          completedAt: new Date('2026-08-12T12:00:00.000Z'),
        },
      ],
      playerId,
      new Date('2026-08-05T12:00:00.000Z'),
      undefined,
    );
    expect(count).toBe(2);
  });

  it('ignores pre-reset matches after a rank reset', () => {
    const count = countCompletedGamesThrough(
      [
        {
          playerId,
          result: MatchResult.WIN,
          completedAt: BEFORE,
        },
        {
          playerId,
          result: MatchResult.WIN,
          completedAt: AFTER,
        },
        {
          playerId,
          result: MatchResult.LOSS,
          completedAt: new Date('2026-08-13T12:00:00.000Z'),
        },
      ],
      playerId,
      new Date('2026-08-13T12:00:00.000Z'),
      RESET,
    );
    expect(count).toBe(2);
  });

  it('excludes matches completed after the through timestamp', () => {
    const count = countCompletedGamesThrough(
      [
        {
          playerId,
          result: MatchResult.WIN,
          completedAt: AFTER,
        },
        {
          playerId,
          result: MatchResult.LOSS,
          completedAt: new Date('2026-08-20T12:00:00.000Z'),
        },
      ],
      playerId,
      AFTER,
      RESET,
    );
    expect(count).toBe(1);
  });
});

describe('aggregateMatchDisplayStats', () => {
  it('uses lifetime W/L when there is no reset', () => {
    const stats = aggregateMatchDisplayStats(
      [
        {
          playerId: 'p1',
          result: MatchResult.WIN,
          isQuitter: false,
          completedAt: BEFORE,
        },
        {
          playerId: 'p1',
          result: MatchResult.LOSS,
          isQuitter: true,
          completedAt: AFTER,
        },
      ],
      new Map(),
    );

    expect(stats.get('p1')).toEqual({
      games: 2,
      wins: 1,
      losses: 1,
      quits: 1,
    });
  });

  it('ignores pre-reset W/L and quits after a rank reset', () => {
    const stats = aggregateMatchDisplayStats(
      [
        {
          playerId: 'p1',
          result: MatchResult.WIN,
          isQuitter: false,
          completedAt: BEFORE,
        },
        {
          playerId: 'p1',
          result: MatchResult.LOSS,
          isQuitter: true,
          completedAt: BEFORE,
        },
        {
          playerId: 'p1',
          result: MatchResult.WIN,
          isQuitter: false,
          completedAt: AFTER,
        },
      ],
      new Map([['p1', RESET]]),
    );

    expect(stats.get('p1')).toEqual({
      games: 1,
      wins: 1,
      losses: 0,
      quits: 0,
    });
  });

  it('returns zeroed stats for a reset player with only pre-reset history', () => {
    const stats = aggregateMatchDisplayStats(
      [
        {
          playerId: 'p1',
          result: MatchResult.WIN,
          isQuitter: false,
          completedAt: BEFORE,
        },
      ],
      new Map([['p1', RESET]]),
    );

    expect(stats.get('p1')).toEqual({
      games: 0,
      wins: 0,
      losses: 0,
      quits: 0,
    });
  });

  it('leaves other players on lifetime counts', () => {
    const stats = aggregateMatchDisplayStats(
      [
        {
          playerId: 'p1',
          result: MatchResult.WIN,
          isQuitter: false,
          completedAt: BEFORE,
        },
        {
          playerId: 'p2',
          result: MatchResult.LOSS,
          isQuitter: false,
          completedAt: BEFORE,
        },
      ],
      new Map([['p1', RESET]]),
    );

    expect(stats.get('p1')?.games).toBe(0);
    expect(stats.get('p2')).toEqual({
      games: 1,
      wins: 0,
      losses: 1,
      quits: 0,
    });
  });
});

describe('gamesByPlayerFromStats', () => {
  it('maps games for displayOrdinal callers', () => {
    const games = gamesByPlayerFromStats(
      new Map([
        ['p1', { games: 5, wins: 3, losses: 2, quits: 0 }],
        ['p2', { games: 0, wins: 0, losses: 0, quits: 1 }],
      ]),
    );
    expect(games.get('p1')).toBe(5);
    expect(games.get('p2')).toBe(0);
  });
});

describe('winRatePercent', () => {
  it('returns null when there are no games', () => {
    expect(winRatePercent(0, 0)).toBeNull();
  });

  it('rounds to one decimal', () => {
    expect(winRatePercent(5, 3)).toBe(62.5);
    expect(winRatePercent(1, 0)).toBe(100);
    expect(winRatePercent(2, 1)).toBe(66.7);
    expect(winRatePercent(0, 1)).toBe(0);
  });
});

describe('aggregateHeroMatchDisplayStats', () => {
  it('groups W/L by player and hero and skips null heroId', () => {
    const stats = aggregateHeroMatchDisplayStats(
      [
        {
          playerId: 'p1',
          heroId: 1,
          result: MatchResult.WIN,
          isQuitter: false,
          completedAt: AFTER,
        },
        {
          playerId: 'p1',
          heroId: 1,
          result: MatchResult.LOSS,
          isQuitter: false,
          completedAt: AFTER,
        },
        {
          playerId: 'p1',
          heroId: 2,
          result: MatchResult.WIN,
          isQuitter: false,
          completedAt: AFTER,
        },
        {
          playerId: 'p1',
          heroId: null,
          result: MatchResult.WIN,
          isQuitter: false,
          completedAt: AFTER,
        },
      ],
      new Map(),
    );

    expect(stats.get('p1')?.get(1)).toEqual({ wins: 1, losses: 1 });
    expect(stats.get('p1')?.get(2)).toEqual({ wins: 1, losses: 0 });
    expect(stats.get('p1')?.has(0)).toBe(false);
  });

  it('ignores pre-reset games and quitters without WIN/LOSS', () => {
    const stats = aggregateHeroMatchDisplayStats(
      [
        {
          playerId: 'p1',
          heroId: 1,
          result: MatchResult.WIN,
          isQuitter: false,
          completedAt: BEFORE,
        },
        {
          playerId: 'p1',
          heroId: 1,
          result: MatchResult.LOSS,
          isQuitter: true,
          completedAt: AFTER,
        },
        {
          playerId: 'p1',
          heroId: 1,
          result: null,
          isQuitter: true,
          completedAt: AFTER,
        },
      ],
      new Map([['p1', RESET]]),
    );

    expect(stats.get('p1')?.get(1)).toEqual({ wins: 0, losses: 1 });
  });
});

describe('heroStatsFor', () => {
  it('returns zeros when the bucket is missing', () => {
    expect(heroStatsFor(new Map(), 'p1', 1)).toEqual({ wins: 0, losses: 0 });
  });
});

describe('isHabitualQuitter', () => {
  it('is false when there are no quits', () => {
    expect(isHabitualQuitter(0, 0)).toBe(false);
    expect(isHabitualQuitter(0, 10)).toBe(false);
  });

  it('is true when there is at least one quit and zero completed games', () => {
    expect(isHabitualQuitter(1, 0)).toBe(true);
  });

  it('flags at 50% inclusive and above', () => {
    expect(isHabitualQuitter(1, 1)).toBe(true);
    expect(isHabitualQuitter(1, 2)).toBe(true);
    expect(isHabitualQuitter(3, 5)).toBe(true);
  });

  it('does not flag below 50%', () => {
    expect(isHabitualQuitter(1, 3)).toBe(false);
    expect(isHabitualQuitter(2, 5)).toBe(false);
  });
});

describe('habitualQuitterFromStats', () => {
  it('uses zeros when the player has no stats row', () => {
    expect(habitualQuitterFromStats(new Map(), 'p1')).toBe(false);
  });

  it('reads quits and games from the stats map', () => {
    const stats = new Map([
      ['p1', { games: 2, wins: 1, losses: 1, quits: 1 }],
      ['p2', { games: 3, wins: 2, losses: 1, quits: 1 }],
    ]);
    expect(habitualQuitterFromStats(stats, 'p1')).toBe(true);
    expect(habitualQuitterFromStats(stats, 'p2')).toBe(false);
  });
});
