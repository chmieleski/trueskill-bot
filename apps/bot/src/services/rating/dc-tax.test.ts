import { describe, expect, it } from 'vitest';
import {
  applyDcSeasonTaxToSeededGlobals,
  computeDcSeasonTaxKi,
  DC_PENALTY_KI,
  DC_PENALTY_THRESHOLD,
  sumDcSeasonTaxByPlayer,
  summarizeDcSeasonTax,
} from './dc-tax.js';
import { displayOrdinal } from './rating-math.js';

describe('computeDcSeasonTaxKi', () => {
  it('returns 0 below threshold', () => {
    expect(computeDcSeasonTaxKi(0)).toBe(0);
    expect(computeDcSeasonTaxKi(2)).toBe(0);
  });

  it('charges 300 ki per 3 DCs', () => {
    expect(DC_PENALTY_THRESHOLD).toBe(3);
    expect(DC_PENALTY_KI).toBe(300);
    expect(computeDcSeasonTaxKi(3)).toBe(300);
    expect(computeDcSeasonTaxKi(5)).toBe(300);
    expect(computeDcSeasonTaxKi(6)).toBe(600);
  });

  it('returns 0 for negative counts', () => {
    expect(computeDcSeasonTaxKi(-1)).toBe(0);
  });
});

describe('sumDcSeasonTaxByPlayer', () => {
  it('counts rows then applies floor(n/3)*300', () => {
    const totals = sumDcSeasonTaxByPlayer([
      { playerId: 'p1' },
      { playerId: 'p1' },
      { playerId: 'p1' },
      { playerId: 'p2' },
      { playerId: 'p2' },
      { playerId: 'p3' },
      { playerId: 'p3' },
      { playerId: 'p3' },
      { playerId: 'p3' },
      { playerId: 'p3' },
      { playerId: 'p3' },
    ]);
    expect(totals.get('p1')).toBe(300);
    expect(totals.has('p2')).toBe(false);
    expect(totals.get('p3')).toBe(600);
  });
});

describe('summarizeDcSeasonTax', () => {
  it('sums players with tax and total ki', () => {
    const summary = summarizeDcSeasonTax(
      new Map([
        ['p1', 300],
        ['p2', 600],
      ]),
    );
    expect(summary).toEqual({ playerCount: 2, totalKiTax: 900 });
  });
});

describe('applyDcSeasonTaxToSeededGlobals', () => {
  it('applies summed tax to seeded mu', () => {
    const seeded = [{ playerId: 'p1', mu: 30, sigma: 8.333 }];
    const taxByPlayer = new Map([['p1', 300]]);
    const gamesByPlayer = new Map([['p1', 10]]);
    const before = displayOrdinal(30, 8.333, 10);
    const [out] = applyDcSeasonTaxToSeededGlobals(seeded, taxByPlayer, gamesByPlayer);
    const after = displayOrdinal(out!.mu, out!.sigma, 10);
    expect(before - after).toBe(300);
  });
});
