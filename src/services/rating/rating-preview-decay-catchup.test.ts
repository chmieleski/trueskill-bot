import { beforeEach, describe, expect, it, vi } from 'vitest';

const applyPendingDecayForPlayers = vi.fn().mockResolvedValue(undefined);

vi.mock('./rating-decay.js', () => ({
  applyPendingDecayForPlayers: (...args: unknown[]) => applyPendingDecayForPlayers(...args),
}));

vi.mock('./rank-reset-display.js', () => ({
  loadMatchDisplayStatsByPlayer: vi.fn().mockResolvedValue(new Map()),
  gamesByPlayerFromStats: () => new Map(),
  habitualQuitterFromStats: () => false,
}));

import { loadRosterWinChance } from './rating-preview.js';

describe('loadRosterWinChance decay catch-up', () => {
  beforeEach(() => {
    applyPendingDecayForPlayers.mockClear();
  });

  it('applies pending decay after ensure and before reading μ', async () => {
    const db = {
      playerRating: {
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
        findMany: vi.fn().mockResolvedValue([
          { playerId: 'p1', mu: 30, sigma: 5 },
          { playerId: 'p2', mu: 20, sigma: 5 },
        ]),
      },
      playerHeroRating: {
        createMany: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    await loadRosterWinChance(
      'league-1',
      [
        { playerId: 'p1', slot: 1, team: 1, heroId: null },
        { playerId: 'p2', slot: 7, team: 2, heroId: null },
      ],
      db as never,
    );

    expect(applyPendingDecayForPlayers).toHaveBeenCalledWith('league-1', ['p1', 'p2'], db);
    expect(applyPendingDecayForPlayers.mock.invocationCallOrder[0]).toBeLessThan(
      db.playerRating.findMany.mock.invocationCallOrder[0],
    );
    expect(db.playerRating.createMany.mock.invocationCallOrder[0]).toBeLessThan(
      applyPendingDecayForPlayers.mock.invocationCallOrder[0]!,
    );
  });
});
