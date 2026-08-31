import { describe, expect, it } from 'vitest';
import { computeWinChanceFromRatings } from './rating-preview.js';

const VET_MU = 20;
const NEW_MU = 25;
const SIGMA = 3;

function makeVet(playerId: string, slot: number, team: 1 | 2) {
  return { playerId, slot, team, heroId: slot };
}

function vetMaps(entries: Array<{ playerId: string; slot: number }>) {
  const globals = new Map(entries.map(({ playerId }) => [playerId, { mu: VET_MU, sigma: SIGMA }]));
  const heroes = new Map(
    entries.map(({ playerId, slot }) => [`${playerId}:${slot}`, { mu: VET_MU, sigma: SIGMA }]),
  );
  return { globals, heroes };
}

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

  it('counts one-sided excess New at 80% of blended μ (~50% for 4+New vs 5)', () => {
    const vetsA = ['a1', 'a2', 'a3', 'a4'];
    const vetsB = ['b1', 'b2', 'b3', 'b4', 'b5'];
    const entries = [
      ...vetsA.map((id, index) => makeVet(id, index + 1, 1)),
      makeVet('newbie', 5, 1),
      ...vetsB.map((id, index) => makeVet(id, index + 7, 2)),
    ].map((entry) =>
      entry.playerId === 'newbie' ? { ...entry, isNewPlayer: true as const } : entry,
    );
    const { globals, heroes } = vetMaps(entries);
    globals.set('newbie', { mu: NEW_MU, sigma: SIGMA });
    heroes.set('newbie:5', { mu: NEW_MU, sigma: SIGMA });

    const winChance = computeWinChanceFromRatings(entries, globals, heroes);
    expect(winChance).toBeDefined();
    expect(winChance!.teamAPercent).toBe(50);
    expect(winChance!.teamAPercent + winChance!.teamBPercent).toBe(100);
  });

  it('omits paired New so win% matches vet-only 5v5', () => {
    const vetsA = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const vetsB = ['b1', 'b2', 'b3', 'b4', 'b5'];
    const vetOnlyEntries = [
      ...vetsA.map((id, index) => makeVet(id, index + 1, 1)),
      ...vetsB.map((id, index) => makeVet(id, index + 7, 2)),
    ];
    const pairedNewEntries = [
      ...vetOnlyEntries,
      { ...makeVet('newA', 6, 1), isNewPlayer: true as const },
      { ...makeVet('newB', 12, 2), isNewPlayer: true as const },
    ];
    const { globals, heroes } = vetMaps(pairedNewEntries);
    globals.set('newA', { mu: NEW_MU, sigma: SIGMA });
    globals.set('newB', { mu: NEW_MU, sigma: SIGMA });
    heroes.set('newA:6', { mu: NEW_MU, sigma: SIGMA });
    heroes.set('newB:12', { mu: NEW_MU, sigma: SIGMA });

    const vetOnly = computeWinChanceFromRatings(vetOnlyEntries, globals, heroes);
    const pairedNew = computeWinChanceFromRatings(pairedNewEntries, globals, heroes);

    expect(vetOnly).toEqual(pairedNew);
    expect(vetOnly!.teamAPercent).toBe(50);
  });

  it('omits paired New and discounts excess (2 New vs 1 New)', () => {
    const entries = [
      ...['a1', 'a2', 'a4', 'a5'].map((id, index) => makeVet(id, [1, 2, 4, 5][index]!, 1)),
      { ...makeVet('newA1', 3, 1), isNewPlayer: true as const },
      { ...makeVet('newA2', 6, 1), isNewPlayer: true as const },
      ...['b1', 'b2', 'b3', 'b4', 'b5'].map((id, index) => makeVet(id, index + 7, 2)),
      { ...makeVet('newB', 12, 2), isNewPlayer: true as const },
    ];
    const { globals, heroes } = vetMaps(entries);
    for (const id of ['newA1', 'newA2', 'newB']) {
      globals.set(id, { mu: NEW_MU, sigma: SIGMA });
    }
    heroes.set('newA1:3', { mu: NEW_MU, sigma: SIGMA });
    heroes.set('newA2:6', { mu: NEW_MU, sigma: SIGMA });
    heroes.set('newB:12', { mu: NEW_MU, sigma: SIGMA });

    const flagged = computeWinChanceFromRatings(entries, globals, heroes);
    const unmarkedNew = computeWinChanceFromRatings(
      entries.map(({ isNewPlayer: _ignored, ...entry }) => entry),
      globals,
      heroes,
    );

    expect(flagged!.teamAPercent).toBeLessThan(unmarkedNew!.teamAPercent);
  });

  it('omits quitters so paired New win% is unchanged after a quit flag', () => {
    const vetsA = ['a1', 'a2', 'a3', 'a4'];
    const vetsB = ['b1', 'b2', 'b3', 'b4', 'b5'];
    const baseEntries = [
      ...vetsA.map((id, index) => makeVet(id, [1, 2, 3, 4][index]!, 1)),
      { ...makeVet('newA', 5, 1), wasNewPlayer: true as const },
      ...vetsB.map((id, index) => makeVet(id, index + 7, 2)),
      { ...makeVet('newB', 12, 2), wasNewPlayer: true as const },
    ];
    const { globals, heroes } = vetMaps(baseEntries);
    globals.set('newA', { mu: NEW_MU, sigma: SIGMA });
    globals.set('newB', { mu: NEW_MU, sigma: SIGMA });
    heroes.set('newA:5', { mu: NEW_MU, sigma: SIGMA });
    heroes.set('newB:12', { mu: NEW_MU, sigma: SIGMA });

    const preMatch = computeWinChanceFromRatings(baseEntries, globals, heroes, {
      staticSigma: true,
    });
    const withQuitter = computeWinChanceFromRatings(
      baseEntries.map((entry) =>
        entry.playerId === 'newA' ? { ...entry, isQuitter: true as const } : entry,
      ),
      globals,
      heroes,
      { staticSigma: true },
    );

    expect(preMatch).toEqual(withQuitter);
    expect(preMatch!.teamAPercent + preMatch!.teamBPercent).toBe(100);
  });

  it('uses full μ for unmarked calibrating players', () => {
    const winChance = computeWinChanceFromRatings(
      [
        { playerId: 'cold', slot: 1, team: 1, heroId: 1 },
        { playerId: 'vet', slot: 7, team: 2, heroId: 7 },
      ],
      new Map([
        ['cold', { mu: NEW_MU, sigma: SIGMA }],
        ['vet', { mu: VET_MU, sigma: SIGMA }],
      ]),
      new Map([
        ['cold:1', { mu: NEW_MU, sigma: SIGMA }],
        ['vet:7', { mu: VET_MU, sigma: SIGMA }],
      ]),
    );

    expect(winChance!.teamAPercent).toBeGreaterThan(50);
  });
});
