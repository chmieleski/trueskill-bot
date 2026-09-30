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

import { loadMatchDisplayStatsByPlayer } from './rank-reset-display.js';

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
