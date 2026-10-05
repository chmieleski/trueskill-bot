import { describe, expect, it } from 'vitest';
import {
  applyQuitterSeasonTaxToSeededGlobals,
  computeQuitterSeasonTaxKi,
  countQuitterIncidents,
  quitterSeasonTaxByPlayer,
  QUITTER_SEASON_TAX_PERCENT,
} from './quitter-tax.js';
import { displayOrdinal } from './rating-math.js';

describe('quitter season tax', () => {
  it('compounds a 10% displayed KI reduction once per quitter incident', () => {
    expect(QUITTER_SEASON_TAX_PERCENT).toBe(0.1);
    expect(computeQuitterSeasonTaxKi(1000, 3)).toBe(271);
    expect(computeQuitterSeasonTaxKi(1000, 0)).toBe(0);
  });

  it('counts incidents and applies the same tax to current and successor ratings', () => {
    const counts = countQuitterIncidents([
      { playerId: 'p1' },
      { playerId: 'p1' },
      { playerId: 'p1' },
    ]);
    const ratings = [{ playerId: 'p1', mu: 0, sigma: 0 }];
    const games = new Map([['p1', 5]]);
    const tax = quitterSeasonTaxByPlayer(ratings, counts, games);
    const [after] = applyQuitterSeasonTaxToSeededGlobals(ratings, counts, games);

    expect(tax.get('p1')).toBe(271);
    expect(displayOrdinal(after!.mu, after!.sigma, 5)).toBe(729);
  });
});
