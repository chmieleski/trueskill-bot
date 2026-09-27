import { beforeEach, describe, expect, it, vi } from 'vitest';

const { leagueFindUnique, playerRatingFindUnique, playerRatingUpdate } = vi.hoisted(() => ({
  leagueFindUnique: vi.fn(),
  playerRatingFindUnique: vi.fn(),
  playerRatingUpdate: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique: leagueFindUnique },
    playerRating: {
      findUnique: playerRatingFindUnique,
      update: playerRatingUpdate,
    },
  },
}));

vi.mock('./rank-reset-display.js', () => ({
  loadMatchDisplayStatsByPlayer: vi.fn(
    async () => new Map([['player-1', { wins: 10, losses: 5 }]]),
  ),
  gamesByPlayerFromStats: vi.fn(() => new Map([['player-1', 15]])),
}));

import { applyPendingDecay } from './rating-decay.js';

describe('applyPendingDecay soft pause', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('does not apply decay when seasonEndsAt has passed', async () => {
    leagueFindUnique.mockResolvedValue({
      status: 'ACTIVE',
      decayEnabled: true,
      seasonEndsAt: new Date('2026-08-01T00:00:00.000Z'),
      crunchStartedAt: null,
      archivedAt: null,
    });
    playerRatingFindUnique.mockResolvedValue({
      mu: 30,
      sigma: 5,
      isNewPlayer: false,
      lastQualifyingActivityAt: new Date('2026-07-01T00:00:00.000Z'),
      idleDecayKiApplied: 0,
      lastDecayAppliedAt: null,
    });

    const result = await applyPendingDecay(
      'league-1',
      'player-1',
      undefined,
      new Date('2026-08-20T12:00:00.000Z'),
    );

    expect(result).toEqual({ applied: false });
    expect(playerRatingUpdate).not.toHaveBeenCalled();
  });
});
