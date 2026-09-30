import { MatchResult } from '@dbz/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  matchFindUnique,
  matchUpdate,
  matchPlayerUpdate,
  matchPlayerFindMany,
  playerRankResetFindMany,
  playerRatingUpdate,
  playerRatingUpdateMany,
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
  persistMatchRatingPreviewToPlayers,
  loadPreMatchGlobalByPlayer,
} = vi.hoisted(() => ({
  matchFindUnique: vi.fn(),
  matchUpdate: vi.fn(),
  matchPlayerUpdate: vi.fn(),
  matchPlayerFindMany: vi.fn(),
  playerRankResetFindMany: vi.fn(),
  playerRatingUpdate: vi.fn(),
  playerRatingUpdateMany: vi.fn(),
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
      findMany: matchPlayerFindMany,
    },
    event: {
      findUnique: vi.fn().mockResolvedValue(null),
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

vi.mock('../../config/env.js', () => ({
  env: { displayStatsSource: 'history' as const },
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

vi.mock('../rating/new-player.js', () => ({
  loadIsNewPlayerByPlayerId,
  playerIdsToClearNewFlag: vi.fn(() => []),
}));

vi.mock('./match-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./match-service.js')>();
  return {
    ...actual,
    getGameProfileForMatch: vi.fn(async () => ({
      postMatchStats: 'none',
      heroBinding: 'slot_bound',
    })),
  };
});

import {
  cancelInProgressMatch,
  completeMatch,
  playersAffectingCancelledDisplay,
} from './match-report.js';
import { loadMatchDisplayStatsFromHistory } from '../rating/rank-reset-display.js';

const leagueId = 'league-1';
const completedAt = new Date('2026-09-30T12:00:00.000Z');

function ihlInProgressMatch() {
  return {
    id: 'match-1',
    status: 'IN_PROGRESS' as const,
    leagueId,
    eventId: null,
    players: [
      {
        matchId: 'match-1',
        playerId: 'p1',
        slot: 1,
        team: 1,
        heroId: 1,
        isQuitter: false,
        isGriefer: false,
        isDc: false,
        wasNewPlayer: false,
        player: { id: 'p1', username: 'alice' },
      },
      {
        matchId: 'match-1',
        playerId: 'p2',
        slot: 7,
        team: 2,
        heroId: 7,
        isQuitter: false,
        isGriefer: false,
        isDc: false,
        wasNewPlayer: false,
        player: { id: 'p2', username: 'bob' },
      },
    ],
  };
}

describe('completeMatch display counters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadPlayerKiBySlot.mockResolvedValue(new Map());
    loadRosterWinChance.mockResolvedValue(undefined);
    loadIsNewPlayerByPlayerId.mockResolvedValue(new Map());
    loadPreMatchGlobalByPlayer.mockResolvedValue(new Map());
    playerRankResetFindMany.mockResolvedValue([]);
    playerRatingUpdate.mockResolvedValue({});
    playerRatingUpdateMany.mockResolvedValue({ count: 0 });
    matchPlayerFindMany.mockImplementation(
      async ({ where }: { where?: { playerId?: { in?: string[] } } }) => {
        const ids = where?.playerId?.in ?? ['p1', 'p2'];
        return ids.flatMap((playerId) => {
          if (playerId === 'p1') {
            return [
              {
                playerId: 'p1',
                heroId: 1,
                team: 1,
                result: MatchResult.WIN,
                isQuitter: false,
                isGriefer: false,
                isDc: false,
                match: { completedAt },
              },
            ];
          }
          if (playerId === 'p2') {
            return [
              {
                playerId: 'p2',
                heroId: 7,
                team: 2,
                result: MatchResult.LOSS,
                isQuitter: false,
                isGriefer: false,
                isDc: false,
                match: { completedAt },
              },
            ];
          }
          return [];
        });
      },
    );

    transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        $queryRaw: queryRaw.mockResolvedValue([{ id: 'match-1' }]),
        match: {
          findUnique: matchFindUnique,
          update: matchUpdate,
        },
        matchPlayer: {
          update: matchPlayerUpdate,
          findMany: matchPlayerFindMany,
        },
        playerRating: {
          update: playerRatingUpdate,
          updateMany: playerRatingUpdateMany,
          findMany: vi.fn().mockResolvedValue([]),
        },
        playerRankReset: {
          findMany: playerRankResetFindMany,
        },
        matchStatsReport: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };
      matchFindUnique.mockResolvedValue(ihlInProgressMatch());
      await fn(tx);
    });
    matchFindUnique.mockResolvedValue({
      ...ihlInProgressMatch(),
      status: 'COMPLETED',
      completedAt,
    });
  });

  it('persists displayWins/Losses that match history aggregation', async () => {
    await completeMatch('match-1', 1);

    const history = await loadMatchDisplayStatsFromHistory(leagueId, ['p1', 'p2'], {
      matchPlayer: { findMany: matchPlayerFindMany },
      playerRankReset: { findMany: playerRankResetFindMany },
      playerRating: { findMany: vi.fn(), update: playerRatingUpdate },
    });

    expect(history.get('p1')).toMatchObject({ wins: 1, losses: 0 });
    expect(history.get('p2')).toMatchObject({ wins: 0, losses: 1 });

    expect(playerRatingUpdate).toHaveBeenCalledWith({
      where: { leagueId_playerId: { leagueId, playerId: 'p1' } },
      data: {
        displayWins: 1,
        displayLosses: 0,
        displayQuits: 0,
        displayGriefs: 0,
        displayDcs: 0,
      },
    });
    expect(playerRatingUpdate).toHaveBeenCalledWith({
      where: { leagueId_playerId: { leagueId, playerId: 'p2' } },
      data: {
        displayWins: 0,
        displayLosses: 1,
        displayQuits: 0,
        displayGriefs: 0,
        displayDcs: 0,
      },
    });
  });
});

describe('playersAffectingCancelledDisplay', () => {
  it('keeps only quit/grief/DC players', () => {
    expect(
      playersAffectingCancelledDisplay([
        { playerId: 'a', isQuitter: false, isGriefer: false, isDc: false },
        { playerId: 'b', isQuitter: true, isGriefer: false, isDc: false },
        { playerId: 'c', isQuitter: false, isGriefer: true, isDc: false },
        { playerId: 'd', isQuitter: false, isGriefer: false, isDc: true },
      ]).map((p) => p.playerId),
    ).toEqual(['b', 'c', 'd']);
  });
});

describe('cancelInProgressMatch display counters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    playerRankResetFindMany.mockResolvedValue([]);
    playerRatingUpdate.mockResolvedValue({});
    matchPlayerFindMany.mockResolvedValue([]);

    transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        $queryRaw: queryRaw.mockResolvedValue([{ id: 'match-1' }]),
        match: {
          findUnique: matchFindUnique,
          update: matchUpdate,
        },
        matchPlayer: {
          update: matchPlayerUpdate,
          findMany: matchPlayerFindMany,
        },
        playerRating: {
          update: playerRatingUpdate,
          updateMany: playerRatingUpdateMany,
          findMany: vi.fn().mockResolvedValue([]),
        },
        playerRankReset: {
          findMany: playerRankResetFindMany,
        },
        matchStatsReport: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };
      await fn(tx);
    });
  });

  it('skips ensure/recompute on clean cancel with no quit/grief/DC', async () => {
    const match = ihlInProgressMatch();
    matchFindUnique
      .mockResolvedValueOnce(match)
      .mockResolvedValueOnce({ ...match, status: 'CANCELLED' });

    await cancelInProgressMatch('match-1');

    expect(ensurePlayerRatings).not.toHaveBeenCalled();
    expect(playerRatingUpdate).not.toHaveBeenCalled();
  });

  it('ensures and recomputes only the quitter on cancel', async () => {
    const match = {
      ...ihlInProgressMatch(),
      players: [
        {
          ...ihlInProgressMatch().players[0],
          isQuitter: true,
        },
        ihlInProgressMatch().players[1],
      ],
    };
    matchFindUnique
      .mockResolvedValueOnce(match)
      .mockResolvedValueOnce({ ...match, status: 'CANCELLED' });
    matchPlayerFindMany.mockResolvedValue([
      {
        playerId: 'p1',
        heroId: 1,
        team: 1,
        result: null,
        isQuitter: true,
        isGriefer: false,
        isDc: false,
        match: { completedAt: null },
      },
    ]);

    await cancelInProgressMatch('match-1');

    expect(ensurePlayerRatings).toHaveBeenCalledWith(
      leagueId,
      [{ playerId: 'p1', heroId: 1 }],
      expect.anything(),
    );
    expect(playerRatingUpdate).toHaveBeenCalledTimes(1);
    expect(playerRatingUpdate).toHaveBeenCalledWith({
      where: { leagueId_playerId: { leagueId, playerId: 'p1' } },
      data: {
        displayWins: 0,
        displayLosses: 0,
        displayQuits: 1,
        displayGriefs: 0,
        displayDcs: 0,
      },
    });
  });
});
