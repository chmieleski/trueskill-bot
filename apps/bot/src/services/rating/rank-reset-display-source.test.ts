import { MatchResult, MatchStatus } from '@dbz/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  displayStatsSource: 'history' as 'history' | 'counters',
}));

const logWarn = vi.hoisted(() => vi.fn());

vi.mock('../../config/env.js', () => ({
  env: mockEnv,
}));

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({
    warn: logWarn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  loadLifetimeDisplayStatsByPlayer,
  loadMatchDisplayStatsByPlayer,
} from './rank-reset-display.js';

const leagueId = 'league-1';
const playerId = 'player-1';
const completedAt = new Date('2026-01-15T12:00:00.000Z');

function historyDb() {
  return {
    playerRankReset: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    matchPlayer: {
      findMany: vi.fn().mockResolvedValue([
        {
          playerId,
          heroId: 1,
          team: 1,
          result: MatchResult.WIN,
          isQuitter: false,
          isGriefer: false,
          isDc: false,
          match: { completedAt },
        },
      ]),
    },
    playerRating: {
      findMany: vi.fn().mockResolvedValue([
        {
          playerId,
          displayWins: 0,
          displayLosses: 0,
          displayQuits: 0,
          displayGriefs: 0,
          displayDcs: 0,
        },
      ]),
    },
  };
}

describe('loadMatchDisplayStatsByPlayer display source', () => {
  beforeEach(() => {
    mockEnv.displayStatsSource = 'history';
    logWarn.mockReset();
  });

  it('shadow returns history on mismatch and logs warn', async () => {
    const db = historyDb();
    const map = await loadMatchDisplayStatsByPlayer(leagueId, [playerId], db);

    expect(map.get(playerId)).toEqual({
      games: 1,
      wins: 1,
      losses: 0,
      quits: 0,
      griefs: 0,
      dcs: 0,
    });
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        leagueId,
        playerId,
        history: expect.objectContaining({ wins: 1 }),
        counters: expect.objectContaining({ wins: 0 }),
      }),
      'display counter shadow mismatch',
    );
  });

  it('counters mode returns PlayerRating columns without history scan', async () => {
    mockEnv.displayStatsSource = 'counters';
    const db = historyDb();
    db.playerRating.findMany.mockResolvedValue([
      {
        playerId,
        displayWins: 4,
        displayLosses: 1,
        displayQuits: 0,
        displayGriefs: 0,
        displayDcs: 0,
      },
    ]);

    const map = await loadMatchDisplayStatsByPlayer(leagueId, [playerId], db);

    expect(db.matchPlayer.findMany).not.toHaveBeenCalled();
    expect(db.playerRankReset.findMany).not.toHaveBeenCalled();
    expect(map.get(playerId)).toEqual({
      games: 5,
      wins: 4,
      losses: 1,
      quits: 0,
      griefs: 0,
      dcs: 0,
    });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('counters mode uses zeros when PlayerRating row is missing', async () => {
    mockEnv.displayStatsSource = 'counters';
    const db = historyDb();
    db.playerRating.findMany.mockResolvedValue([]);

    const map = await loadMatchDisplayStatsByPlayer(leagueId, [playerId], db);

    expect(map.get(playerId)).toEqual({
      games: 0,
      wins: 0,
      losses: 0,
      quits: 0,
      griefs: 0,
      dcs: 0,
    });
  });
});

describe('loadLifetimeDisplayStatsByPlayer', () => {
  beforeEach(() => {
    mockEnv.displayStatsSource = 'counters';
  });

  it('adds predecessor league stats onto current-league stats', async () => {
    const predecessors: Record<string, string | null> = {
      'league-3': 'league-2',
      'league-2': 'league-1',
      'league-1': null,
    };
    const countersByLeague: Record<string, { displayWins: number; displayQuits: number }> = {
      'league-2': { displayWins: 1, displayQuits: 3 },
      'league-1': { displayWins: 2, displayQuits: 0 },
    };
    const db = {
      league: {
        findUnique: vi.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve({ predecessorLeagueId: predecessors[where.id] ?? null }),
        ),
      },
      playerRankReset: { findMany: vi.fn().mockResolvedValue([]) },
      matchPlayer: { findMany: vi.fn().mockResolvedValue([]) },
      playerRating: {
        findMany: vi.fn(({ where }: { where: { leagueId: string } }) =>
          Promise.resolve([
            {
              playerId,
              displayLosses: 0,
              displayGriefs: 0,
              displayDcs: 0,
              ...countersByLeague[where.leagueId],
            },
          ]),
        ),
      },
    };
    const current = new Map([
      [playerId, { games: 1, wins: 1, losses: 0, quits: 0, griefs: 0, dcs: 0 }],
    ]);

    const lifetime = await loadLifetimeDisplayStatsByPlayer('league-3', [playerId], current, db);

    expect(lifetime.get(playerId)).toEqual({
      games: 4,
      wins: 4,
      losses: 0,
      quits: 3,
      griefs: 0,
      dcs: 0,
    });
    expect(current.get(playerId)?.quits).toBe(0);
  });

  it('returns current stats when the league has no predecessor', async () => {
    const db = {
      league: { findUnique: vi.fn().mockResolvedValue({ predecessorLeagueId: null }) },
      playerRankReset: { findMany: vi.fn() },
      matchPlayer: { findMany: vi.fn() },
      playerRating: { findMany: vi.fn() },
    };
    const current = new Map([
      [playerId, { games: 2, wins: 1, losses: 1, quits: 1, griefs: 0, dcs: 0 }],
    ]);

    const lifetime = await loadLifetimeDisplayStatsByPlayer(leagueId, [playerId], current, db);

    expect(lifetime).toEqual(current);
    expect(db.playerRating.findMany).not.toHaveBeenCalled();
  });
});
