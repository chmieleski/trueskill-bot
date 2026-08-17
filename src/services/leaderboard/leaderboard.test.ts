import { describe, expect, it } from 'vitest';
import {
  LeaderboardServiceError,
  LIVE_LEADERBOARD_CHUNK_SIZE,
  assertLiveLeaderboardSize,
  assignSortedRanks,
  chunkLeaderboardEntries,
  clampPage,
  paginateOverall,
  rankLeaderboardRows,
  type OverallLeaderboardEntry,
} from './leaderboard.js';

describe('assertLiveLeaderboardSize', () => {
  it('accepts bounds and mid values', () => {
    expect(assertLiveLeaderboardSize(10)).toBe(10);
    expect(assertLiveLeaderboardSize(50)).toBe(50);
    expect(assertLiveLeaderboardSize(100)).toBe(100);
  });

  it('rejects out of range and non-integers', () => {
    expect(() => assertLiveLeaderboardSize(9)).toThrow(LeaderboardServiceError);
    expect(() => assertLiveLeaderboardSize(101)).toThrow(LeaderboardServiceError);
    expect(() => assertLiveLeaderboardSize(10.5)).toThrow(LeaderboardServiceError);
    expect(() => assertLiveLeaderboardSize(9)).toThrow(
      /Live leaderboard size must be between 10 and 100/,
    );
  });
});

describe('chunkLeaderboardEntries', () => {
  it('chunks by 25', () => {
    const entries = Array.from({ length: 26 }, (_, i) => i);
    expect(chunkLeaderboardEntries(entries)).toEqual([
      entries.slice(0, 25),
      entries.slice(25),
    ]);
    expect(chunkLeaderboardEntries(entries.slice(0, 10))).toEqual([entries.slice(0, 10)]);
    expect(chunkLeaderboardEntries(Array.from({ length: 100 }, (_, i) => i))).toHaveLength(4);
    expect(LIVE_LEADERBOARD_CHUNK_SIZE).toBe(25);
  });

  it('returns empty array for empty input', () => {
    expect(chunkLeaderboardEntries([])).toEqual([]);
  });

  it('rejects zero or negative chunk size', () => {
    const entries = [1, 2, 3];
    expect(() => chunkLeaderboardEntries(entries, 0)).toThrow(LeaderboardServiceError);
    expect(() => chunkLeaderboardEntries(entries, -1)).toThrow(LeaderboardServiceError);
    expect(() => chunkLeaderboardEntries(entries, 0)).toThrow(
      /Leaderboard chunk size must be a positive integer/,
    );
  });
});

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

describe('rankLeaderboardRows', () => {
  it('ranks calibrated players then appends calibrating with null rank', () => {
    const rows = rankLeaderboardRows(
      [
        { username: 'vetB', ki: 3000, games: 10 },
        { username: 'newHighKi', ki: 9000, games: 2 },
        { username: 'vetA', ki: 5000, games: 20 },
        { username: 'newLowKi', ki: 800, games: 4 },
        { username: 'newTiedGamesA', ki: 100, games: 3 },
        { username: 'newTiedGamesB', ki: 9999, games: 3 },
      ],
      (row) => row.games,
    );

    expect(rows.map((row) => row.username)).toEqual([
      'vetA',
      'vetB',
      'newLowKi',
      'newTiedGamesA',
      'newTiedGamesB',
      'newHighKi',
    ]);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, null, null, null, null]);
  });

  it('uses competition ranks among calibrated only', () => {
    const rows = rankLeaderboardRows(
      [
        { username: 'a', ki: 4000, games: 5 },
        { username: 'b', ki: 4000, games: 8 },
        { username: 'c', ki: 3000, games: 6 },
        { username: 'd', ki: 9999, games: 1 },
      ],
      (row) => row.games,
    );
    expect(rows.map((row) => row.rank)).toEqual([1, 1, 3, null]);
  });
});

describe('paginateOverall', () => {
  const base: OverallLeaderboardEntry[] = Array.from({ length: 25 }, (_, i) => ({
    rank: i + 1,
    playerId: `p${i}`,
    username: `user${i}`,
    ki: 5000 - i * 10,
    games: 5,
    leagueGames: 5,
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
