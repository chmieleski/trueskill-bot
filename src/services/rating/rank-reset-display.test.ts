import { describe, expect, it } from 'vitest';
import { MatchResult } from '@prisma/client';
import {
  aggregateMatchDisplayStats,
  gamesByPlayerFromStats,
  isMatchCountedAfterRankReset,
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
