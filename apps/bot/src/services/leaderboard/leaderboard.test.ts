import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  playerRatingFindMany,
  leagueFindUnique,
  loadMatchDisplayStatsByPlayer,
  loadPendingSeasonTaxByPlayer,
  applyPendingDecayForPlayers,
} = vi.hoisted(() => ({
  playerRatingFindMany: vi.fn(),
  leagueFindUnique: vi.fn(),
  loadMatchDisplayStatsByPlayer: vi.fn(),
  loadPendingSeasonTaxByPlayer: vi.fn(),
  applyPendingDecayForPlayers: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    playerRating: { findMany: playerRatingFindMany },
    league: { findUnique: leagueFindUnique },
  },
}));

vi.mock('../rating/rank-reset-display.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rating/rank-reset-display.js')>();
  return {
    ...actual,
    loadMatchDisplayStatsByPlayer,
    loadPendingSeasonTaxByPlayer,
  };
});

vi.mock('../rating/rating-decay.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rating/rating-decay.js')>();
  return {
    ...actual,
    applyPendingDecayForPlayers,
  };
});

import {
  LeaderboardServiceError,
  LIVE_LEADERBOARD_CHUNK_SIZE,
  assertLiveLeaderboardSize,
  assignPrizeMedalRanks,
  assignSortedRanks,
  chunkLeaderboardEntries,
  clampPage,
  loadOverallLeaderboardTop,
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
    expect(chunkLeaderboardEntries(entries)).toEqual([entries.slice(0, 25), entries.slice(25)]);
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
    const rows = assignSortedRanks([{ ki: 5000 }, { ki: 4000 }, { ki: 4000 }, { ki: 3000 }]);
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
    winRatePercent: 50,
  }));

  it('returns page 2 with 10 entries', () => {
    const page = paginateOverall(base, 2);
    expect(page.page).toBe(2);
    expect(page.totalPages).toBe(3);
    expect(page.totalPlayers).toBe(25);
    expect(page.entries).toHaveLength(10);
    expect(page.entries[0]?.username).toBe('user10');
    expect(page.prizeLockActive).toBe(false);
  });

  it('forwards prizeLockActive', () => {
    const page = paginateOverall(base, 1, true);
    expect(page.prizeLockActive).toBe(true);
  });
});

describe('assignPrizeMedalRanks', () => {
  it('skips ineligible players when assigning medals', () => {
    const ranked = assignPrizeMedalRanks([
      { prizeEligible: false },
      { prizeEligible: true },
      { prizeEligible: true },
      { prizeEligible: false },
      { prizeEligible: true },
      { prizeEligible: true },
    ]);
    expect(ranked.map((row) => row.medalRank)).toEqual([null, 1, 2, null, 3, null]);
  });
});

describe('loadEligibleOverallRows display-stats scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyPendingDecayForPlayers.mockResolvedValue(undefined);
    leagueFindUnique.mockResolvedValue({
      status: 'ACTIVE',
      decayEnabled: false,
      seasonEndsAt: null,
      crunchStartedAt: null,
      archivedAt: null,
    });
    playerRatingFindMany
      .mockResolvedValueOnce([{ playerId: 'p1' }, { playerId: 'p2' }])
      .mockResolvedValueOnce([
        {
          playerId: 'p1',
          mu: 25,
          sigma: 8.333,
          lastQualifyingActivityAt: null,
          player: { id: 'p1', username: 'alpha', discordId: 'd1' },
        },
        {
          playerId: 'p2',
          mu: 25,
          sigma: 8.333,
          lastQualifyingActivityAt: null,
          player: { id: 'p2', username: 'bravo', discordId: 'd2' },
        },
      ]);
    loadMatchDisplayStatsByPlayer.mockResolvedValue(
      new Map([
        ['p1', { games: 10, wins: 6, losses: 4, quits: 0, griefs: 0, dcs: 0 }],
        ['p2', { games: 8, wins: 3, losses: 5, quits: 0, griefs: 0, dcs: 0 }],
      ]),
    );
    loadPendingSeasonTaxByPlayer.mockResolvedValue(new Map());
  });

  it('passes rating player ids into loadMatchDisplayStatsByPlayer', async () => {
    await loadOverallLeaderboardTop('league-1', 10);

    expect(loadMatchDisplayStatsByPlayer).toHaveBeenCalledWith(
      'league-1',
      expect.arrayContaining(['p1', 'p2']),
    );
  });
});

describe('loadEligibleOverallRows soft ki', () => {
  const ratings = [
    {
      playerId: 'p1',
      mu: 40,
      sigma: 3,
      lastQualifyingActivityAt: null,
      player: { id: 'p1', username: 'alpha', discordId: 'd1' },
    },
    {
      playerId: 'p2',
      mu: 35,
      sigma: 3,
      lastQualifyingActivityAt: null,
      player: { id: 'p2', username: 'bravo', discordId: 'd2' },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    applyPendingDecayForPlayers.mockResolvedValue(undefined);
    playerRatingFindMany
      .mockResolvedValueOnce([{ playerId: 'p1' }, { playerId: 'p2' }])
      .mockResolvedValueOnce(ratings);
    loadMatchDisplayStatsByPlayer.mockResolvedValue(
      new Map([
        ['p1', { games: 20, wins: 10, losses: 10, quits: 0, griefs: 0, dcs: 0 }],
        ['p2', { games: 20, wins: 10, losses: 10, quits: 0, griefs: 0, dcs: 0 }],
      ]),
    );
    loadPendingSeasonTaxByPlayer.mockResolvedValue(new Map([['p1', 100_000]]));
  });

  it('ranks by ki after pending season taxes, clamped at 0', async () => {
    leagueFindUnique.mockResolvedValue({ status: 'ACTIVE', archivedAt: null });

    const { entries } = await loadOverallLeaderboardTop('league-1', 10);

    expect(entries.map((e) => [e.playerId, e.rank])).toEqual([
      ['p2', 1],
      ['p1', 2],
    ]);
    expect(entries[1]!.ki).toBe(0);
  });

  it('ignores pending tax on an archived league (already applied at rollover)', async () => {
    leagueFindUnique.mockResolvedValue({ status: 'ARCHIVED', archivedAt: new Date() });

    const { entries } = await loadOverallLeaderboardTop('league-1', 10);

    expect(entries.map((e) => e.playerId)).toEqual(['p1', 'p2']);
    expect(entries[0]!.ki).toBeGreaterThan(entries[1]!.ki);
  });
});
