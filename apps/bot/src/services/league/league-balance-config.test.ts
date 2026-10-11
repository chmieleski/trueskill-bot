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

import {
  balanceModeFromFlags,
  parseBalanceMode,
  setBalanceMode,
  setShowSideWinLoss,
} from './league-balance-config.js';

describe('setBalanceMode', () => {
  beforeEach(() => {
    update.mockReset();
    update.mockResolvedValue({});
  });

  it.each([
    ['dynamic', false, false],
    ['static', true, false],
    ['ki', false, true],
  ] as const)('%s writes both flags', async (mode, staticSigma, ki) => {
    await setBalanceMode('league-1', mode);

    expect(update).toHaveBeenCalledWith({
      where: { id: 'league-1' },
      data: { balanceStaticSigmaEnabled: staticSigma, balanceKiStrengthEnabled: ki },
    });
  });
});

describe('balanceModeFromFlags', () => {
  it('maps flags to a mode, ki first', () => {
    const flags = (s: boolean, k: boolean) => ({
      balanceStaticSigmaEnabled: s,
      balanceKiStrengthEnabled: k,
    });
    expect(balanceModeFromFlags(flags(false, false))).toBe('dynamic');
    expect(balanceModeFromFlags(flags(true, false))).toBe('static');
    expect(balanceModeFromFlags(flags(true, true))).toBe('ki');
  });
});

describe('parseBalanceMode', () => {
  it('accepts known modes only', () => {
    expect(parseBalanceMode('ki')).toBe('ki');
    expect(parseBalanceMode('elo')).toBeUndefined();
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
