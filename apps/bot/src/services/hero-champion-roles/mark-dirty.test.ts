import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@dbz/db';
import { markLeagueHeroChampionRolesDirty } from './mark-dirty.js';

const { leagueUpdate } = vi.hoisted(() => ({
  leagueUpdate: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: {
      update: leagueUpdate,
    },
  },
}));

describe('markLeagueHeroChampionRolesDirty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates league heroChampionRolesDirty using default prisma client', async () => {
    leagueUpdate.mockResolvedValue({});

    await markLeagueHeroChampionRolesDirty('league-1');

    expect(leagueUpdate).toHaveBeenCalledWith({
      where: { id: 'league-1' },
      data: { heroChampionRolesDirty: true, rankRolesDirty: true },
    });
  });

  it('updates league heroChampionRolesDirty using provided transaction client', async () => {
    const customTxUpdate = vi.fn().mockResolvedValue({});
    const customTx = {
      league: {
        update: customTxUpdate,
      },
    } as unknown as Prisma.TransactionClient;

    await markLeagueHeroChampionRolesDirty('league-2', customTx);

    expect(customTxUpdate).toHaveBeenCalledWith({
      where: { id: 'league-2' },
      data: { heroChampionRolesDirty: true, rankRolesDirty: true },
    });
    expect(leagueUpdate).not.toHaveBeenCalled();
  });

  it('handles update failure gracefully without throwing', async () => {
    leagueUpdate.mockRejectedValue(new Error('DB connection closed'));

    await expect(markLeagueHeroChampionRolesDirty('league-fail')).resolves.toBeUndefined();
  });
});
