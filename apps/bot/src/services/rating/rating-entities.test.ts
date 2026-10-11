import { describe, expect, it } from 'vitest';
import {
  BALANCE_STATIC_SIGMA,
  balanceEntitiesForSeat,
  blendedRatingForBalance,
  effectiveBalanceMuForExcessNew,
  kiStrengthEntityForBalance,
  ratingEntitiesForBalance,
  ratingEntitiesForHero,
  ratingEntitiesForOverall,
  rosterEntriesWithHeroId,
} from './rating-entities.js';
import { displayOrdinal } from './rating-math.js';

const G = { mu: 25, sigma: 8.333 };
const H = { mu: 28, sigma: 7 };

describe('ratingEntitiesForOverall', () => {
  it('returns only the global entity', () => {
    expect(ratingEntitiesForOverall(G)).toEqual([G]);
  });
});

describe('ratingEntitiesForHero', () => {
  it('returns only the hero entity', () => {
    expect(ratingEntitiesForHero(H)).toEqual([H]);
  });
});

describe('blendedRatingForBalance', () => {
  it('weights player μ at 80% and hero μ at 20%', () => {
    const blended = blendedRatingForBalance({ mu: 40, sigma: 4 }, { mu: 10, sigma: 8 });

    expect(blended.mu).toBeCloseTo(0.8 * 40 + 0.2 * 10);
    expect(blended.sigma).toBeCloseTo(Math.sqrt((0.8 * 4) ** 2 + (0.2 * 8) ** 2));
  });

  it('uses fixed σ when staticSigma is enabled', () => {
    const blended = blendedRatingForBalance(
      { mu: 40, sigma: 4 },
      { mu: 10, sigma: 8 },
      { staticSigma: true },
    );

    expect(blended.mu).toBeCloseTo(0.8 * 40 + 0.2 * 10);
    expect(blended.sigma).toBe(BALANCE_STATIC_SIGMA);
  });
});

describe('ratingEntitiesForBalance', () => {
  it('returns one 80/20 blended entity when heroId is set', () => {
    expect(ratingEntitiesForBalance(G, H, 3)).toEqual([blendedRatingForBalance(G, H)]);
  });

  it('returns global only when heroId is null', () => {
    expect(ratingEntitiesForBalance(G, H, null)).toEqual([G]);
  });

  it('uses global μ with fixed σ for WOS when staticSigma is enabled', () => {
    expect(ratingEntitiesForBalance(G, H, null, { staticSigma: true })).toEqual([
      { mu: G.mu, sigma: BALANCE_STATIC_SIGMA },
    ]);
  });
});

describe('effectiveBalanceMuForExcessNew', () => {
  it('applies 80% weight for cold-start New μ', () => {
    expect(effectiveBalanceMuForExcessNew(25)).toBe(20);
  });

  it('caps discounted μ at 20 for high-μ mis-flags', () => {
    expect(effectiveBalanceMuForExcessNew(60)).toBe(20);
  });

  it('applies weight without cap for typical vet blend', () => {
    expect(effectiveBalanceMuForExcessNew(20)).toBe(16);
  });
});

describe('rosterEntriesWithHeroId', () => {
  it('returns empty when every heroId is null', () => {
    expect(
      rosterEntriesWithHeroId([
        { playerId: 'p1', heroId: null },
        { playerId: 'p2', heroId: null },
      ]),
    ).toEqual([]);
  });

  it('keeps only entries with a non-null heroId', () => {
    expect(
      rosterEntriesWithHeroId([
        { playerId: 'p1', heroId: null },
        { playerId: 'p2', heroId: 7 },
      ]),
    ).toEqual([{ playerId: 'p2', heroId: 7 }]);
  });
});

describe('kiStrengthEntityForBalance', () => {
  it('blends player/hero ki strength 80/20 with fixed σ', () => {
    const global = { mu: 30, sigma: 3, games: 10 };
    const hero = { mu: 26, sigma: 5, games: 2 };
    const entity = kiStrengthEntityForBalance(global, hero, 4);

    const kiG = displayOrdinal(global.mu, global.sigma, global.games);
    const kiH = displayOrdinal(hero.mu, hero.sigma, hero.games);
    // 1000 + 200 × strength reproduces the displayed ki blend (± rounding).
    expect(1000 + 200 * entity.mu).toBeCloseTo(0.8 * kiG + 0.2 * kiH, -1);
    expect(entity.sigma).toBe(BALANCE_STATIC_SIGMA);
  });

  it('uses global ki only for WOS seats', () => {
    const global = { mu: 30, sigma: 3, games: 10 };
    expect(kiStrengthEntityForBalance(global, H, null).mu).toBeCloseTo(30 - 2.5 * 3);
  });

  it('treats missing games as cold start (z = 3)', () => {
    expect(kiStrengthEntityForBalance(G, G, null).mu).toBeCloseTo(25 - 3 * 8.333);
  });
});

describe('balanceEntitiesForSeat with kiStrength', () => {
  const classification = { frozenKeys: new Set(['1:1']), excessKeys: new Set(['1:2']) };

  it('keeps paired New seats instead of omitting them', () => {
    expect(balanceEntitiesForSeat(G, H, 1, '1:1', classification, { kiStrength: true })).toEqual([
      kiStrengthEntityForBalance(G, H, 1),
    ]);
  });

  it('does not discount excess New seats', () => {
    expect(balanceEntitiesForSeat(G, H, 2, '1:2', classification, { kiStrength: true })).toEqual([
      kiStrengthEntityForBalance(G, H, 2),
    ]);
  });

  it('is unchanged when kiStrength is off', () => {
    expect(balanceEntitiesForSeat(G, H, 1, '1:1', classification, {})).toEqual([]);
  });
});
