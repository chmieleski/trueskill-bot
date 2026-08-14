import { describe, expect, it } from 'vitest';
import {
  assignSortedRanks,
  clampPage,
  paginateOverall,
  type OverallLeaderboardEntry,
} from './leaderboard.js';

describe('clampPage', () => {
  it('clamps below 1 and above totalPages', () => {
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(99, 5)).toBe(5);
    expect(clampPage(3, 5)).toBe(3);
  });

  it('returns 1 when totalPages is 0', () => {
    expect(clampPage(5, 0)).toBe(1);
  });
});

describe('assignSortedRanks', () => {
  it('uses competition ranks for tied ki', () => {
    const rows = assignSortedRanks([
      { ki: 5000 },
      { ki: 4000 },
      { ki: 4000 },
      { ki: 3000 },
    ]);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, 2, 4]);
  });
});

describe('paginateOverall', () => {
  const base: OverallLeaderboardEntry[] = Array.from({ length: 25 }, (_, i) => ({
    rank: i + 1,
    playerId: `p${i}`,
    username: `user${i}`,
    ki: 5000 - i * 10,
    games: 5,
    discordId: null,
  }));

  it('returns page 2 with 10 entries', () => {
    const page = paginateOverall(base, 2);
    expect(page.page).toBe(2);
    expect(page.totalPages).toBe(3);
    expect(page.totalPlayers).toBe(25);
    expect(page.entries).toHaveLength(10);
    expect(page.entries[0]?.username).toBe('user10');
  });
});
