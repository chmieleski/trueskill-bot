import { beforeEach, describe, expect, it, vi } from 'vitest';

const { matchPlayerFindMany, playerRankResetFindMany, matchRatingSnapshotFindMany } = vi.hoisted(
  () => ({
    matchPlayerFindMany: vi.fn(),
    playerRankResetFindMany: vi.fn(),
    matchRatingSnapshotFindMany: vi.fn(),
  }),
);

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    matchRatingSnapshot: { findMany: matchRatingSnapshotFindMany },
    matchPlayer: {
      groupBy: vi.fn(),
      findMany: matchPlayerFindMany,
      update: vi.fn(),
    },
    playerRankReset: { findMany: playerRankResetFindMany },
  },
}));

import {
  ratingPreviewFromStoredMatchPlayers,
  resolveCompletedRatingPreview,
} from './match-history-preview.js';
import type { MatchWithPlayers } from './match-service.js';
import { CALIBRATING_LABEL, formatPublicKi } from '../rating/rating-math.js';
import { prisma } from '../../lib/prisma.js';

function storedMatchFixture(): MatchWithPlayers {
  return {
    id: 'm1',
    leagueId: 'L1',
    status: 'COMPLETED',
    completedAt: new Date('2026-08-10T00:00:00.000Z'),
    createdAt: new Date('2026-08-10T00:00:00.000Z'),
    hostId: 'host',
    players: [
      {
        playerId: 'P1',
        team: 1,
        result: 'WIN',
        slot: 3,
        heroId: 3,
        isQuitter: false,
        globalKi: 4100,
        globalKiDelta: 80,
        heroKi: 4050,
        heroKiDelta: 40,
        player: { username: 'alice' },
      },
      {
        playerId: 'P2',
        team: 2,
        result: 'LOSS',
        slot: 8,
        heroId: 8,
        isQuitter: false,
        globalKi: 3900,
        globalKiDelta: -60,
        heroKi: 3880,
        heroKiDelta: -30,
        player: { username: 'bob' },
      },
    ],
  } as MatchWithPlayers;
}

/** Build WIN/LOSS rows: first `throughCount` at/before match time, rest after. */
function completedRowsForPlayer(
  playerId: string,
  throughCount: number,
  totalCount: number,
  matchCompletedAt: Date,
): Array<{
  playerId: string;
  result: 'WIN' | 'LOSS';
  match: { completedAt: Date; createdAt: Date };
}> {
  const rows = [];
  for (let i = 0; i < throughCount; i += 1) {
    rows.push({
      playerId,
      result: 'WIN' as const,
      match: {
        completedAt: new Date(matchCompletedAt.getTime() - (throughCount - i) * 86_400_000),
        createdAt: new Date(matchCompletedAt.getTime() - (throughCount - i) * 86_400_000),
      },
    });
  }
  for (let i = throughCount; i < totalCount; i += 1) {
    rows.push({
      playerId,
      result: 'WIN' as const,
      match: {
        completedAt: new Date(matchCompletedAt.getTime() + (i - throughCount + 1) * 86_400_000),
        createdAt: new Date(matchCompletedAt.getTime() + (i - throughCount + 1) * 86_400_000),
      },
    });
  }
  return rows;
}

describe('ratingPreviewFromStoredMatchPlayers', () => {
  it('attaches leagueGames from the display-stats map', () => {
    const leagueGamesByPlayer = new Map([
      ['P1', 2],
      ['P2', 4],
    ]);

    const displayStatsByPlayer = new Map([
      ['P1', { games: 2, wins: 1, losses: 1, quits: 1 }],
      ['P2', { games: 4, wins: 3, losses: 1, quits: 0 }],
    ]);

    const preview = ratingPreviewFromStoredMatchPlayers(
      storedMatchFixture(),
      leagueGamesByPlayer,
      displayStatsByPlayer,
    );

    expect(preview?.players).toEqual([
      expect.objectContaining({ slot: 3, leagueGames: 2, habitualQuitter: true }),
      expect.objectContaining({ slot: 8, leagueGames: 4, habitualQuitter: false }),
    ]);
  });
});

describe('resolveCompletedRatingPreview', () => {
  beforeEach(() => {
    matchPlayerFindMany.mockReset();
    playerRankResetFindMany.mockReset();
    matchRatingSnapshotFindMany.mockReset();
    playerRankResetFindMany.mockResolvedValue([]);
    matchRatingSnapshotFindMany.mockResolvedValue([]);
  });

  it('uses point-in-time after-match games, not current league totals', async () => {
    const match = storedMatchFixture();
    const completedAt = match.completedAt!;

    matchPlayerFindMany.mockResolvedValue([
      ...completedRowsForPlayer('P1', 3, 10, completedAt),
      ...completedRowsForPlayer('P2', 3, 10, completedAt),
    ]);

    const preview = await resolveCompletedRatingPreview(match);

    expect(playerRankResetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ leagueId: 'L1', playerId: { in: ['P1', 'P2'] } }),
      }),
    );
    expect(matchPlayerFindMany).toHaveBeenCalled();
    expect(preview?.players).toEqual([
      expect.objectContaining({ slot: 3, leagueGames: 3 }),
      expect.objectContaining({ slot: 8, leagueGames: 3 }),
    ]);
    for (const line of preview?.players ?? []) {
      expect(formatPublicKi(line.globalOrdinal, line.leagueGames)).toBe(CALIBRATING_LABEL);
    }
  });

  it('attaches pre-match win chance from rating snapshots', async () => {
    const match = storedMatchFixture();
    const completedAt = match.completedAt!;

    matchPlayerFindMany.mockResolvedValue([
      ...completedRowsForPlayer('P1', 5, 5, completedAt),
      ...completedRowsForPlayer('P2', 5, 5, completedAt),
    ]);
    matchRatingSnapshotFindMany.mockResolvedValue([
      {
        playerId: 'P1',
        entityKind: 'GLOBAL',
        heroId: 0,
        mu: 40,
        sigma: 3,
        matchesPlayed: null,
      },
      {
        playerId: 'P1',
        entityKind: 'HERO',
        heroId: 3,
        mu: 40,
        sigma: 3,
        matchesPlayed: 5,
      },
      {
        playerId: 'P2',
        entityKind: 'GLOBAL',
        heroId: 0,
        mu: 20,
        sigma: 3,
        matchesPlayed: null,
      },
      {
        playerId: 'P2',
        entityKind: 'HERO',
        heroId: 8,
        mu: 20,
        sigma: 3,
        matchesPlayed: 5,
      },
    ]);

    const preview = await resolveCompletedRatingPreview(match);

    expect(prisma.matchRatingSnapshot.findMany).toHaveBeenCalledWith({
      where: { matchId: 'm1' },
    });
    expect(preview?.winChance).toBeDefined();
    expect(preview!.winChance!.teamAPercent).toBeGreaterThan(50);
    expect(preview!.winChance!.teamAPercent + preview!.winChance!.teamBPercent).toBe(100);
  });
});
