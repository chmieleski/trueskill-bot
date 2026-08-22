import { describe, expect, it } from 'vitest';
import {
  blendedRatingForBalance,
  ratingEntitiesForBalance,
  ratingEntitiesForHero,
  ratingEntitiesForOverall,
  rosterEntriesWithHeroId,
} from './rating-entities.js';

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
});

describe('ratingEntitiesForBalance', () => {
  it('returns one 80/20 blended entity when heroId is set', () => {
    expect(ratingEntitiesForBalance(G, H, 3)).toEqual([blendedRatingForBalance(G, H)]);
  });

  it('returns global only when heroId is null', () => {
    expect(ratingEntitiesForBalance(G, H, null)).toEqual([G]);
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
