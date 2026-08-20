import { describe, expect, it } from 'vitest';
import { computeWinChanceFromRatings } from './rating-preview.js';

describe('computeWinChanceFromRatings', () => {
  it('returns undefined when a team is empty', () => {
    expect(
      computeWinChanceFromRatings(
        [
          { playerId: 'p1', slot: 1, team: 1, heroId: 1 },
          { playerId: 'p2', slot: 2, team: 1, heroId: 2 },
        ],
        new Map([
          ['p1', { mu: 30, sigma: 5 }],
          ['p2', { mu: 28, sigma: 5 }],
        ]),
        new Map(),
      ),
    ).toBeUndefined();
  });

  it('favors the higher-μ team and sums to 100', () => {
    const winChance = computeWinChanceFromRatings(
      [
        { playerId: 'p1', slot: 1, team: 1, heroId: 1 },
        { playerId: 'p2', slot: 7, team: 2, heroId: 7 },
      ],
      new Map([
        ['p1', { mu: 40, sigma: 3 }],
        ['p2', { mu: 20, sigma: 3 }],
      ]),
      new Map([
        ['p1:1', { mu: 40, sigma: 3 }],
        ['p2:7', { mu: 20, sigma: 3 }],
      ]),
    );

    expect(winChance).toBeDefined();
    expect(winChance!.teamAPercent).toBeGreaterThan(50);
    expect(winChance!.teamAPercent + winChance!.teamBPercent).toBe(100);
  });
});
