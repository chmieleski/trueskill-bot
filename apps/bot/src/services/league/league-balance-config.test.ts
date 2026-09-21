import { beforeEach, describe, expect, it, vi } from 'vitest';

const { update } = vi.hoisted(() => ({
  update: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: {
      update,
    },
  },
}));

import { setBalanceStaticSigmaEnabled, setShowSideWinLoss } from './league-balance-config.js';

describe('setBalanceStaticSigmaEnabled', () => {
  beforeEach(() => {
    update.mockReset();
    update.mockResolvedValue({});
  });

  it('persists the league flag', async () => {
    await setBalanceStaticSigmaEnabled('league-1', true);

    expect(update).toHaveBeenCalledWith({
      where: { id: 'league-1' },
      data: { balanceStaticSigmaEnabled: true },
    });
  });
});

describe('setShowSideWinLoss', () => {
  beforeEach(() => {
    update.mockReset();
    update.mockResolvedValue({});
  });

  it('persists the league flag', async () => {
    await setShowSideWinLoss('league-1', false);

    expect(update).toHaveBeenCalledWith({
      where: { id: 'league-1' },
      data: { showSideWinLoss: false },
    });
  });
});
