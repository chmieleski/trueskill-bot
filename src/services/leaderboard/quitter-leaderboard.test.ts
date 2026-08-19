import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchStatus } from '@prisma/client';

const matchPlayerFindMany = vi.fn();
const guildFindUnique = vi.fn();

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    matchPlayer: { findMany: (...a: unknown[]) => matchPlayerFindMany(...a) },
    guildConfig: { findUnique: (...a: unknown[]) => guildFindUnique(...a) },
  },
}));

import {
  LeaderboardServiceError,
  assertQuitterLeaderboardSize,
  assignCompetitionRanks,
  filterEligibleQuitterRows,
  loadQuitterLeaderboard,
  paginateQuitterEntries,
  sortQuitterRows,
} from './quitter-leaderboard.js';

describe('assertQuitterLeaderboardSize', () => {
  it('rejects out of range with quitter message', () => {
    expect(() => assertQuitterLeaderboardSize(9)).toThrow(LeaderboardServiceError);
    expect(() => assertQuitterLeaderboardSize(9)).toThrow(
      /Quitter leaderboard size must be between 10 and 100/,
    );
    expect(assertQuitterLeaderboardSize(25)).toBe(25);
  });
});

describe('sort + ranks', () => {
  const base = [
    {
      playerId: 'a',
      username: 'Ann',
      discordId: null,
      quitCount: 5,
      completedCount: 10,
      rate: 0.5,
    },
    {
      playerId: 'b',
      username: 'Bob',
      discordId: null,
      quitCount: 5,
      completedCount: 20,
      rate: 0.25,
    },
    { playerId: 'c', username: 'Cat', discordId: null, quitCount: 2, completedCount: 2, rate: 1 },
  ];

  it('sorts by count then rate then name', () => {
    const sorted = sortQuitterRows(base, 'count');
    expect(sorted.map((r) => r.playerId)).toEqual(['a', 'b', 'c']);
  });

  it('sorts by rate then count then name', () => {
    const sorted = sortQuitterRows(base, 'rate');
    expect(sorted.map((r) => r.playerId)).toEqual(['c', 'a', 'b']);
  });

  it('assigns competition ranks on tied primary metric', () => {
    const ranked = assignCompetitionRanks(
      sortQuitterRows(base, 'count'),
      (x, y) => x.quitCount === y.quitCount,
    );
    expect(ranked.map((r) => r.rank)).toEqual([1, 1, 3]);
  });
});

describe('filterEligibleQuitterRows', () => {
  it('keeps quitters for count sort and completed>=1 for rate sort', () => {
    const rows = [
      { playerId: 'a', username: 'A', discordId: null, quitCount: 1, completedCount: 0, rate: 0 },
      { playerId: 'b', username: 'B', discordId: null, quitCount: 0, completedCount: 5, rate: 0 },
    ];
    expect(filterEligibleQuitterRows(rows, 'count').map((r) => r.playerId)).toEqual(['a']);
    expect(filterEligibleQuitterRows(rows, 'rate').map((r) => r.playerId)).toEqual(['b']);
  });
});

describe('paginateQuitterEntries', () => {
  it('pages by 10', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      rank: i + 1,
      playerId: `p${i}`,
      username: `u${i}`,
      discordId: null,
      quitCount: 12 - i,
      completedCount: 20,
      rate: (12 - i) / 20,
    }));
    const page2 = paginateQuitterEntries(entries, 2, 'both', 'count');
    expect(page2.page).toBe(2);
    expect(page2.totalPages).toBe(2);
    expect(page2.entries).toHaveLength(2);
  });
});

describe('loadQuitterLeaderboard', () => {
  beforeEach(() => {
    matchPlayerFindMany.mockReset();
  });

  it('aggregates across guild leagues and excludes other guilds', async () => {
    matchPlayerFindMany.mockResolvedValue([
      {
        playerId: 'p1',
        isQuitter: true,
        match: { status: MatchStatus.COMPLETED },
        player: { username: 'Goku', discordId: 'd1' },
      },
      {
        playerId: 'p1',
        isQuitter: false,
        match: { status: MatchStatus.COMPLETED },
        player: { username: 'Goku', discordId: 'd1' },
      },
      {
        playerId: 'p1',
        isQuitter: true,
        match: { status: MatchStatus.CANCELLED },
        player: { username: 'Goku', discordId: 'd1' },
      },
    ]);

    const rows = await loadQuitterLeaderboard('guild-1', {
      display: 'both',
      sort: 'count',
    });

    expect(matchPlayerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          match: expect.objectContaining({
            league: { guildId: 'guild-1' },
            status: { in: [MatchStatus.COMPLETED, MatchStatus.CANCELLED] },
          }),
        }),
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      username: 'Goku',
      quitCount: 2,
      completedCount: 2,
      rate: 1,
      rank: 1,
    });
  });
});
