import { describe, expect, it } from 'vitest';
import { ratingEntitiesForPlayer } from './rating-entities.js';

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
