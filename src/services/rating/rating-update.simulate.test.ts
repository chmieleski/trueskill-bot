import { describe, expect, it } from 'vitest';
import { simulatePostMatchRatings } from './rating-update.js';

describe('simulatePostMatchRatings', () => {
  it('moves winner global mu up vs loser', () => {
    const entries = [
      {
        playerId: 'a',
        slot: 1,
        team: 1 as const,
        heroId: null,
        isQuitter: false,
      },
      {
        playerId: 'b',
        slot: 7,
        team: 2 as const,
        heroId: null,
        isQuitter: false,
      },
    ];
    const start = new Map([
      ['a', { mu: 25, sigma: 8.333 }],
      ['b', { mu: 25, sigma: 8.333 }],
    ]);
    const { globalByPlayer } = simulatePostMatchRatings(entries, 1, start, new Map());
    expect(globalByPlayer.get('a')!.mu).toBeGreaterThan(25);
    expect(globalByPlayer.get('b')!.mu).toBeLessThan(25);
  });
});
