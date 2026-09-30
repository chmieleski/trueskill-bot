import { MatchResult } from '@dbz/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  displayStatsSource: 'counters' as 'history' | 'counters',
}));

vi.mock('../../config/env.js', () => ({
  env: mockEnv,
}));

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { recomputeDisplayCountersForPlayer } from './display-counters.js';

const leagueId = 'league-1';
const playerId = 'player-1';
const completedAt = new Date('2026-01-15T12:00:00.000Z');

describe('recomputeDisplayCountersForPlayer', () => {
  beforeEach(() => {
    mockEnv.displayStatsSource = 'counters';
  });

  it('uses match history even when DISPLAY_STATS_SOURCE is counters', async () => {
    const update = vi.fn().mockResolvedValue({});
    const db = {
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
        findMany: vi.fn(),
        update,
      },
    };

    const stats = await recomputeDisplayCountersForPlayer(leagueId, playerId, db);

    expect(db.matchPlayer.findMany).toHaveBeenCalled();
    expect(db.playerRating.findMany).not.toHaveBeenCalled();
    expect(stats).toEqual({
      games: 1,
      wins: 1,
      losses: 0,
      quits: 0,
      griefs: 0,
      dcs: 0,
    });
    expect(update).toHaveBeenCalledWith({
      where: { leagueId_playerId: { leagueId, playerId } },
      data: {
        displayWins: 1,
        displayLosses: 0,
        displayQuits: 0,
        displayGriefs: 0,
        displayDcs: 0,
      },
    });
  });
});
