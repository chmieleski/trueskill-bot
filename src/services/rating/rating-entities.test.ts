import { describe, expect, it } from 'vitest';
import { ratingEntitiesForPlayer, rosterEntriesWithHeroId } from './rating-entities.js';

const G = { mu: 25, sigma: 8.333 };
const H = { mu: 28, sigma: 7 };

describe('ratingEntitiesForPlayer', () => {
  it('returns global + hero when heroId is set', () => {
    expect(ratingEntitiesForPlayer(G, H, 3)).toEqual([G, H]);
  });

  it('returns global only when heroId is null', () => {
    expect(ratingEntitiesForPlayer(G, H, null)).toEqual([G]);
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
