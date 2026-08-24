import { describe, expect, it } from 'vitest';
import {
  assertGrieferLeaderboardSize,
  filterEligibleGrieferRows,
  sortGrieferRows,
} from './griefer-leaderboard.js';
import { LeaderboardServiceError } from './leaderboard.js';

describe('assertGrieferLeaderboardSize', () => {
  it('rejects out of range with griefer message', () => {
    expect(() => assertGrieferLeaderboardSize(9)).toThrow(LeaderboardServiceError);
    expect(() => assertGrieferLeaderboardSize(9)).toThrow(
      /Griefer leaderboard size must be between 10 and 100/,
    );
    expect(assertGrieferLeaderboardSize(25)).toBe(25);
  });
});

describe('sortGrieferRows', () => {
  const base = [
    {
      playerId: 'a',
      username: 'Ann',
      discordId: null,
      griefCount: 5,
      completedCount: 10,
      rate: 0.5,
      pendingTaxKi: 500,
    },
    {
      playerId: 'b',
      username: 'Bob',
      discordId: null,
      griefCount: 5,
      completedCount: 20,
      rate: 0.25,
      pendingTaxKi: 200,
    },
  ];

  it('sorts by count then rate then name', () => {
    const sorted = sortGrieferRows(base, 'count');
    expect(sorted.map((r) => r.playerId)).toEqual(['a', 'b']);
  });
});

describe('filterEligibleGrieferRows', () => {
  it('keeps griefers for count sort and completed>=1 for rate sort', () => {
    const rows = [
      {
        playerId: 'a',
        username: 'A',
        discordId: null,
        griefCount: 1,
        completedCount: 0,
        rate: 0,
        pendingTaxKi: 100,
      },
      {
        playerId: 'b',
        username: 'B',
        discordId: null,
        griefCount: 0,
        completedCount: 5,
        rate: 0,
        pendingTaxKi: 0,
      },
    ];
    expect(filterEligibleGrieferRows(rows, 'count').map((r) => r.playerId)).toEqual(['a']);
    expect(filterEligibleGrieferRows(rows, 'rate').map((r) => r.playerId)).toEqual(['b']);
  });
});
