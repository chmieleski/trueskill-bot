import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  matchFindUnique,
  matchUpdate,
  matchPlayerUpdate,
  transaction,
  queryRaw,
  applyMatchRatings,
  applyQuitterPenalties,
  accrueGrieferPenalties,
  writeMatchRatingSnapshots,
  ensurePlayerRatings,
  loadPlayerKiBySlot,
  loadRosterWinChance,
  loadIsNewPlayerByPlayerId,
  loadMatchDisplayStatsByPlayer,
  persistMatchRatingPreviewToPlayers,
  loadPreMatchGlobalByPlayer,
} = vi.hoisted(() => ({
  matchFindUnique: vi.fn(),
  matchUpdate: vi.fn(),
  matchPlayerUpdate: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  applyMatchRatings: vi.fn(),
  applyQuitterPenalties: vi.fn(),
  accrueGrieferPenalties: vi.fn(),
  writeMatchRatingSnapshots: vi.fn(),
  ensurePlayerRatings: vi.fn(),
  loadPlayerKiBySlot: vi.fn(),
  loadRosterWinChance: vi.fn(),
  loadIsNewPlayerByPlayerId: vi.fn(),
  loadMatchDisplayStatsByPlayer: vi.fn(),
  persistMatchRatingPreviewToPlayers: vi.fn(),
  loadPreMatchGlobalByPlayer: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    $transaction: transaction,
    $queryRaw: queryRaw,
    match: {
      findUnique: matchFindUnique,
      update: matchUpdate,
    },
    matchPlayer: {
      update: matchPlayerUpdate,
    },
    event: {
      findUnique: vi.fn().mockResolvedValue({ gameId: 'warcraft3_udbr' }),
    },
    matchStatsReport: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../rating/rating-update.js', () => ({
  applyMatchRatings,
  applyQuitterPenalties,
  accrueGrieferPenalties,
  assertBothTeamsHaveActivePlayers: vi.fn(),
  loadLiveGlobalByPlayer: vi.fn(),
  loadPreMatchGlobalByPlayer,
}));

vi.mock('../rating/rating-preview.js', () => ({
  buildCompletedRatingPreview: vi.fn(() => ({ players: [] })),
  ensurePlayerRatings,
  loadPlayerKiBySlot,
  loadRosterWinChance,
  matchPlayersToRatingEntries: vi.fn((players: unknown[]) => players),
}));

vi.mock('./match-correction.js', () => ({
  writeMatchRatingSnapshots,
  flipCompletedMatch: vi.fn(),
  previewMatchCorrection: vi.fn(),
}));

vi.mock('./match-history-preview.js', () => ({
  persistMatchRatingPreviewToPlayers,
}));

vi.mock('../rating/rank-reset-display.js', () => ({
  gamesByPlayerFromStats: vi.fn(() => new Map()),
  loadMatchDisplayStatsByPlayer,
}));

vi.mock('../rating/new-player.js', () => ({
  loadIsNewPlayerByPlayerId,
  playerIdsToClearNewFlag: vi.fn(() => []),
}));

import { completeMatch, cancelInProgressMatch } from './match-report.js';

function eventInProgressMatch() {
  return {
    id: 'event-match-1',
    status: 'IN_PROGRESS' as const,
    leagueId: null,
    eventId: 'event-1',
    players: [
      {
        matchId: 'event-match-1',
        playerId: 'p1',
        slot: 1,
        team: 1,
        heroId: 1,
        isQuitter: false,
        isGriefer: false,
        wasNewPlayer: false,
        player: { id: 'p1', username: 'alice' },
      },
      {
        matchId: 'event-match-1',
        playerId: 'p2',
        slot: 7,
        team: 2,
        heroId: 7,
        isQuitter: false,
        isGriefer: false,
        wasNewPlayer: false,
        player: { id: 'p2', username: 'bob' },
      },
    ],
  };
}

describe('completeMatch event path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        $queryRaw: queryRaw.mockResolvedValue([{ id: 'event-match-1' }]),
        match: {
          findUnique: matchFindUnique,
          update: matchUpdate,
        },
        matchPlayer: {
          update: matchPlayerUpdate,
        },
        playerRating: {
          updateMany: vi.fn(),
        },
        matchStatsReport: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };
      matchFindUnique.mockResolvedValue(eventInProgressMatch());
      await fn(tx);
    });
    matchFindUnique.mockResolvedValue({
      ...eventInProgressMatch(),
      status: 'COMPLETED',
    });
  });

  it('stores results without calling rating services', async () => {
    await completeMatch('event-match-1', 1);

    expect(matchPlayerUpdate).toHaveBeenCalled();
    expect(matchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );
    expect(applyMatchRatings).not.toHaveBeenCalled();
    expect(applyQuitterPenalties).not.toHaveBeenCalled();
    expect(accrueGrieferPenalties).not.toHaveBeenCalled();
    expect(writeMatchRatingSnapshots).not.toHaveBeenCalled();
    expect(ensurePlayerRatings).not.toHaveBeenCalled();
  });
});

describe('cancelInProgressMatch event path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        $queryRaw: queryRaw.mockResolvedValue([{ id: 'event-match-1' }]),
        match: {
          findUnique: matchFindUnique,
          update: matchUpdate,
        },
        matchPlayer: {
          update: matchPlayerUpdate,
        },
      };
      matchFindUnique.mockResolvedValue(eventInProgressMatch());
      await fn(tx);
    });
    matchFindUnique.mockResolvedValue({
      ...eventInProgressMatch(),
      status: 'CANCELLED',
    });
  });

  it('cancels without rating side effects', async () => {
    await cancelInProgressMatch('event-match-1');

    expect(matchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    );
    expect(applyQuitterPenalties).not.toHaveBeenCalled();
    expect(accrueGrieferPenalties).not.toHaveBeenCalled();
  });
});
