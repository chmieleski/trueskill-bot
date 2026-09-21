import { describe, expect, it } from 'vitest';
import {
  applyGrieferSeasonTaxToSeededGlobals,
  applyKiTaxToMu,
  computeGrieferKiAccrual,
  GRIEFER_KI_TAX_CAP_KI,
  GRIEFER_KI_TAX_PERCENT,
  sumGrieferKiTaxByPlayer,
} from './griefer-tax.js';
import { displayOrdinal } from './rating-math.js';

describe('computeGrieferKiAccrual', () => {
  it('accrues 25% of global ki', () => {
    expect(computeGrieferKiAccrual(1000)).toBe(250);
    expect(computeGrieferKiAccrual(1000)).toBe(Math.round(1000 * GRIEFER_KI_TAX_PERCENT));
  });

  it('caps at 500 ki per incident', () => {
    expect(computeGrieferKiAccrual(4000)).toBe(GRIEFER_KI_TAX_CAP_KI);
    expect(computeGrieferKiAccrual(3000)).toBe(GRIEFER_KI_TAX_CAP_KI);
  });

  it('returns 0 for non-positive ki', () => {
    expect(computeGrieferKiAccrual(0)).toBe(0);
  });
});

describe('applyKiTaxToMu', () => {
  it('reduces display ki by the tax amount', () => {
    const mu = 25;
    const sigma = 8.333;
    const games = 10;
    const before = displayOrdinal(mu, sigma, games);
    const after = displayOrdinal(applyKiTaxToMu(mu, sigma, games, 200), sigma, games);
    expect(before - after).toBe(200);
  });

  it('floors resulting ki at 0', () => {
    const mu = 25;
    const sigma = 8.333;
    const games = 0;
    const taxed = applyKiTaxToMu(mu, sigma, games, 5000);
    expect(displayOrdinal(taxed, sigma, games)).toBe(0);
  });
});

describe('sumGrieferKiTaxByPlayer', () => {
  it('sums accruals per player', () => {
    const totals = sumGrieferKiTaxByPlayer([
      { playerId: 'p1', grieferKiAccrued: 100 },
      { playerId: 'p1', grieferKiAccrued: 50 },
      { playerId: 'p2', grieferKiAccrued: 200 },
      { playerId: 'p3', grieferKiAccrued: null },
    ]);
    expect(totals.get('p1')).toBe(150);
    expect(totals.get('p2')).toBe(200);
    expect(totals.has('p3')).toBe(false);
  });
});

describe('applyGrieferSeasonTaxToSeededGlobals', () => {
  it('applies summed tax to seeded mu', () => {
    const seeded = [{ playerId: 'p1', mu: 30, sigma: 8.333 }];
    const taxByPlayer = new Map([['p1', 200]]);
    const gamesByPlayer = new Map([['p1', 10]]);
    const before = displayOrdinal(30, 8.333, 10);
    const [out] = applyGrieferSeasonTaxToSeededGlobals(seeded, taxByPlayer, gamesByPlayer);
    const after = displayOrdinal(out!.mu, out!.sigma, 10);
    expect(before - after).toBe(200);
  });
});
