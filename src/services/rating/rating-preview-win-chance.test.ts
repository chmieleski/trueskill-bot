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

  it('weights player skill over hero skill at 80/20 for win chance', () => {
    const winChance = computeWinChanceFromRatings(
      [
        { playerId: 'strong', slot: 1, team: 1, heroId: 1 },
        { playerId: 'weak', slot: 7, team: 2, heroId: 7 },
      ],
      new Map([
        ['strong', { mu: 40, sigma: 3 }],
        ['weak', { mu: 20, sigma: 3 }],
      ]),
      new Map([
        ['strong:1', { mu: 20, sigma: 3 }],
        ['weak:7', { mu: 40, sigma: 3 }],
      ]),
    );

    expect(winChance).toBeDefined();
    expect(winChance!.teamAPercent).toBeGreaterThan(50);
    expect(winChance!.teamAPercent + winChance!.teamBPercent).toBe(100);
  });

  it('static σ is insensitive to persisted σ when μ is unchanged', () => {
    const entries = [
      { playerId: 'p1', slot: 1, team: 1 as const, heroId: 1 },
      { playerId: 'p2', slot: 7, team: 2 as const, heroId: 7 },
    ];
    const mixedGlobals = new Map([
      ['p1', { mu: 40, sigma: 3 }],
      ['p2', { mu: 20, sigma: 8.333 }],
    ]);
    const swappedGlobals = new Map([
      ['p1', { mu: 40, sigma: 8.333 }],
      ['p2', { mu: 20, sigma: 3 }],
    ]);
    const mixedHeroes = new Map([
      ['p1:1', { mu: 40, sigma: 3 }],
      ['p2:7', { mu: 20, sigma: 8.333 }],
    ]);
    const swappedHeroes = new Map([
      ['p1:1', { mu: 40, sigma: 8.333 }],
      ['p2:7', { mu: 20, sigma: 3 }],
    ]);

    const staticMixed = computeWinChanceFromRatings(entries, mixedGlobals, mixedHeroes, {
      staticSigma: true,
    });
    const staticSwapped = computeWinChanceFromRatings(entries, swappedGlobals, swappedHeroes, {
      staticSigma: true,
    });

    expect(staticMixed).toEqual(staticSwapped);
  });

  it('static σ can produce a different win% than dynamic σ', () => {
    const entries = [
      { playerId: 'p1', slot: 1, team: 1 as const, heroId: 1 },
      { playerId: 'p2', slot: 7, team: 2 as const, heroId: 7 },
    ];
    const globals = new Map([
      ['p1', { mu: 28, sigma: 3 }],
      ['p2', { mu: 25, sigma: 8.333 }],
    ]);
    const heroes = new Map([
      ['p1:1', { mu: 28, sigma: 3 }],
      ['p2:7', { mu: 25, sigma: 8.333 }],
    ]);

    const dynamic = computeWinChanceFromRatings(entries, globals, heroes);
    const staticSigma = computeWinChanceFromRatings(entries, globals, heroes, {
      staticSigma: true,
    });

    expect(dynamic!.teamAPercent).not.toBe(staticSigma!.teamAPercent);
  });
});
