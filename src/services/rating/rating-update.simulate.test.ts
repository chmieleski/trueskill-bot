import { describe, expect, it } from 'vitest';
import { displayOrdinal } from './rating-math.js';
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

  it('high-rated loser loses more ki after lobby-relative scaling', () => {
    const highMu = 32;
    const highSigma = 5;
    const lowMu = 25;
    const lowSigma = 8.333;
    const highKi = displayOrdinal(highMu, highSigma, 20);
    const lowKi = displayOrdinal(lowMu, lowSigma, 20);

    const entries = [
      { playerId: 'high', slot: 1, team: 1 as const, heroId: 1, isQuitter: false },
      { playerId: 'lowA', slot: 2, team: 1 as const, heroId: 2, isQuitter: false },
      { playerId: 'lowB', slot: 7, team: 2 as const, heroId: 7, isQuitter: false },
      { playerId: 'lowC', slot: 8, team: 2 as const, heroId: 8, isQuitter: false },
    ];
    const startGlobal = new Map([
      ['high', { mu: highMu, sigma: highSigma }],
      ['lowA', { mu: lowMu, sigma: lowSigma }],
      ['lowB', { mu: lowMu, sigma: lowSigma }],
      ['lowC', { mu: lowMu, sigma: lowSigma }],
    ]);
    const startHero = new Map([
      ['high:1', { mu: highMu - 1, sigma: highSigma + 0.5 }],
      ['lowA:2', { mu: lowMu - 1, sigma: lowSigma + 0.5 }],
      ['lowB:7', { mu: lowMu - 1, sigma: lowSigma + 0.5 }],
      ['lowC:8', { mu: lowMu - 1, sigma: lowSigma + 0.5 }],
    ]);
    const games = new Map([
      ['high', 20],
      ['lowA', 20],
      ['lowB', 20],
      ['lowC', 20],
    ]);

    const after = simulatePostMatchRatings(entries, 2, startGlobal, startHero, games);
    const highDelta = displayOrdinal(after.globalByPlayer.get('high')!.mu, highSigma, 21) - highKi;
    const lowDelta = displayOrdinal(after.globalByPlayer.get('lowA')!.mu, lowSigma, 21) - lowKi;

    expect(Math.abs(highDelta)).toBeGreaterThan(15);
    expect(Math.abs(lowDelta)).toBeLessThan(Math.abs(highDelta) * 3);
  });
});

describe('simulatePostMatchRatings with New', () => {
  it('freezes New non-quit μ and still rates veterans', () => {
    const entries = [
      {
        playerId: 'newA',
        slot: 1,
        team: 1 as const,
        heroId: null,
        isQuitter: false,
        wasNewPlayer: true,
      },
      {
        playerId: 'vetA',
        slot: 2,
        team: 1 as const,
        heroId: null,
        isQuitter: false,
        wasNewPlayer: false,
      },
      {
        playerId: 'newB',
        slot: 7,
        team: 2 as const,
        heroId: null,
        isQuitter: false,
        wasNewPlayer: true,
      },
      {
        playerId: 'vetB',
        slot: 8,
        team: 2 as const,
        heroId: null,
        isQuitter: false,
        wasNewPlayer: false,
      },
    ];
    const start = new Map([
      ['newA', { mu: 25, sigma: 8.333 }],
      ['vetA', { mu: 32, sigma: 5 }],
      ['newB', { mu: 25, sigma: 8.333 }],
      ['vetB', { mu: 32, sigma: 5 }],
    ]);

    const { globalByPlayer } = simulatePostMatchRatings(entries, 1, start, new Map());

    expect(globalByPlayer.get('newA')!.mu).toBe(25);
    expect(globalByPlayer.get('newB')!.mu).toBe(25);
    expect(globalByPlayer.get('vetA')!.mu).toBeGreaterThan(32);
    expect(globalByPlayer.get('vetB')!.mu).toBeLessThan(32);
  });

  it('rates one-sided New μ when the other team has no non-quit New', () => {
    const entries = [
      {
        playerId: 'vetA',
        slot: 1,
        team: 1 as const,
        heroId: null,
        isQuitter: false,
        wasNewPlayer: false,
      },
      {
        playerId: 'newB',
        slot: 7,
        team: 2 as const,
        heroId: null,
        isQuitter: false,
        wasNewPlayer: true,
      },
    ];
    const start = new Map([
      ['vetA', { mu: 32, sigma: 5 }],
      ['newB', { mu: 25, sigma: 8.333 }],
    ]);

    const { globalByPlayer } = simulatePostMatchRatings(entries, 1, start, new Map());

    expect(globalByPlayer.get('vetA')!.mu).toBeGreaterThan(32);
    expect(globalByPlayer.get('newB')!.mu).not.toBe(25);
  });

  it('keeps veteran Δμ unchanged when paired New quits instead of finishing', () => {
    const mkVet = (playerId: string, slot: number, team: 1 | 2) => ({
      playerId,
      slot,
      team,
      heroId: slot,
      isQuitter: false,
      wasNewPlayer: false as const,
    });
    const base = [
      mkVet('v1', 1, 1),
      {
        playerId: 'newA',
        slot: 2,
        team: 1 as const,
        heroId: 2,
        isQuitter: false,
        wasNewPlayer: true,
      },
      mkVet('v3', 3, 1),
      mkVet('v4', 4, 1),
      mkVet('v5', 5, 1),
      mkVet('v6', 6, 1),
      mkVet('v7', 7, 2),
      mkVet('v8', 8, 2),
      mkVet('v9', 9, 2),
      mkVet('v10', 10, 2),
      {
        playerId: 'newB',
        slot: 11,
        team: 2 as const,
        heroId: 11,
        isQuitter: false,
        wasNewPlayer: true,
      },
      mkVet('v11', 12, 2),
    ];
    const vetIds = ['v1', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10', 'v11'];
    const startGlobal = new Map(
      [...vetIds, 'newA', 'newB'].map((id) => [id, { mu: 30, sigma: 5 }] as const),
    );
    const startHero = new Map(
      base.map((entry) => [`${entry.playerId}:${entry.heroId}`, { mu: 28, sigma: 6 }] as const),
    );
    const games = new Map(vetIds.map((id) => [id, 10] as const));

    const noQuit = simulatePostMatchRatings(base, 1, startGlobal, startHero, games);
    const oneQuit = simulatePostMatchRatings(
      base.map((entry) => (entry.playerId === 'newA' ? { ...entry, isQuitter: true } : entry)),
      1,
      startGlobal,
      startHero,
      games,
    );

    for (const id of vetIds) {
      expect(oneQuit.globalByPlayer.get(id)!.mu).toBeCloseTo(noQuit.globalByPlayer.get(id)!.mu);
    }
    expect(oneQuit.globalByPlayer.get('newB')!.mu).toBe(30);
  });

  it('skips team rate when both sides are only New (quitters optional)', () => {
    const entries = [
      {
        playerId: 'newA',
        slot: 1,
        team: 1 as const,
        heroId: null,
        isQuitter: false,
        wasNewPlayer: true,
      },
      {
        playerId: 'newB',
        slot: 7,
        team: 2 as const,
        heroId: null,
        isQuitter: false,
        wasNewPlayer: true,
      },
      {
        playerId: 'quitA',
        slot: 2,
        team: 1 as const,
        heroId: null,
        isQuitter: true,
        wasNewPlayer: true,
      },
    ];
    const start = new Map([
      ['newA', { mu: 25, sigma: 8.333 }],
      ['newB', { mu: 25, sigma: 8.333 }],
      ['quitA', { mu: 25, sigma: 8.333 }],
    ]);

    const { globalByPlayer } = simulatePostMatchRatings(entries, 1, start, new Map());

    expect(globalByPlayer.get('newA')!.mu).toBe(25);
    expect(globalByPlayer.get('newB')!.mu).toBe(25);
    expect(globalByPlayer.get('quitA')!.mu).toBeLessThan(25);
  });
});

describe('simulatePostMatchRatings quit synthetics', () => {
  it('moves overall Δμ the same regardless of hero μ/σ', () => {
    const entries = [
      {
        playerId: 'quitA',
        slot: 1,
        team: 1 as const,
        heroId: 1,
        isQuitter: true,
      },
      {
        playerId: 'vetB',
        slot: 7,
        team: 2 as const,
        heroId: null,
        isQuitter: false,
      },
    ];
    const overall = { mu: 28, sigma: 6 };
    const afterCold = simulatePostMatchRatings(
      entries,
      2,
      new Map([
        ['quitA', overall],
        ['vetB', { mu: 25, sigma: 8.333 }],
      ]),
      new Map([['quitA:1', { mu: 25, sigma: 8.333 }]]),
    );
    const afterMain = simulatePostMatchRatings(
      entries,
      2,
      new Map([
        ['quitA', overall],
        ['vetB', { mu: 25, sigma: 8.333 }],
      ]),
      new Map([['quitA:1', { mu: 35, sigma: 3 }]]),
    );

    expect(afterCold.globalByPlayer.get('quitA')!.mu).toBeCloseTo(
      afterMain.globalByPlayer.get('quitA')!.mu,
    );
    expect(afterCold.heroByKey.get('quitA:1')!.mu).not.toBeCloseTo(
      afterMain.heroByKey.get('quitA:1')!.mu,
    );
  });
});

describe('independent overall vs hero rate', () => {
  it('gives the same overall Δμ on a cold hero as on a main', () => {
    const overallA = { mu: 32, sigma: 5 };
    const overallB = { mu: 25, sigma: 8.333 };
    const entries = [
      { playerId: 'a', slot: 1, team: 1 as const, heroId: 1, isQuitter: false },
      { playerId: 'b', slot: 7, team: 2 as const, heroId: 7, isQuitter: false },
    ];
    const globals = new Map([
      ['a', overallA],
      ['b', overallB],
    ]);
    const afterCold = simulatePostMatchRatings(
      entries,
      1,
      globals,
      new Map([
        ['a:1', { mu: 25, sigma: 8.333 }],
        ['b:7', { mu: 25, sigma: 8.333 }],
      ]),
    );
    const afterMain = simulatePostMatchRatings(
      entries,
      1,
      globals,
      new Map([
        ['a:1', { mu: 32, sigma: 5 }],
        ['b:7', { mu: 25, sigma: 8.333 }],
      ]),
    );

    const coldOverallDelta = afterCold.globalByPlayer.get('a')!.mu - overallA.mu;
    const mainOverallDelta = afterMain.globalByPlayer.get('a')!.mu - overallA.mu;
    expect(coldOverallDelta).toBeCloseTo(mainOverallDelta);

    const coldHeroDelta = afterCold.heroByKey.get('a:1')!.mu - 25;
    const mainHeroDelta = afterMain.heroByKey.get('a:1')!.mu - 32;
    expect(coldHeroDelta).not.toBeCloseTo(mainHeroDelta);
  });

  it('skips hero rate when one team has no hero seats and still updates overall', () => {
    const entries = [
      { playerId: 'aca', slot: 1, team: 1 as const, heroId: null, isQuitter: false },
      { playerId: 'udbr', slot: 7, team: 2 as const, heroId: 7, isQuitter: false },
    ];
    const startGlobal = new Map([
      ['aca', { mu: 25, sigma: 8.333 }],
      ['udbr', { mu: 25, sigma: 8.333 }],
    ]);
    const startHero = new Map([['udbr:7', { mu: 28, sigma: 7 }]]);
    const after = simulatePostMatchRatings(entries, 1, startGlobal, startHero);

    expect(after.globalByPlayer.get('aca')!.mu).toBeGreaterThan(25);
    expect(after.globalByPlayer.get('udbr')!.mu).toBeLessThan(25);
    expect(after.heroByKey.get('udbr:7')!.mu).toBe(28);
    expect(after.heroByKey.get('udbr:7')!.sigma).toBe(7);
  });
});

describe('simulatePostMatchRatings with mitigation', () => {
  it('shrinks both sides team Δμ equally at 50%', () => {
    const entries = [
      { playerId: 'a', slot: 1, team: 1 as const, heroId: null, isQuitter: false },
      { playerId: 'b', slot: 7, team: 2 as const, heroId: null, isQuitter: false },
    ];
    const start = new Map([
      ['a', { mu: 25, sigma: 8.333 }],
      ['b', { mu: 25, sigma: 8.333 }],
    ]);
    const full = simulatePostMatchRatings(entries, 1, start, new Map());
    const soft = simulatePostMatchRatings(entries, 1, start, new Map(), new Map(), 50);

    const fullWinDelta = full.globalByPlayer.get('a')!.mu - 25;
    const softWinDelta = soft.globalByPlayer.get('a')!.mu - 25;
    const fullLossDelta = full.globalByPlayer.get('b')!.mu - 25;
    const softLossDelta = soft.globalByPlayer.get('b')!.mu - 25;

    expect(softWinDelta).toBeCloseTo(fullWinDelta * 0.5, 5);
    expect(softLossDelta).toBeCloseTo(fullLossDelta * 0.5, 5);
  });

  it('does not scale quitter synthetic losses', () => {
    const entries = [
      { playerId: 'quit', slot: 1, team: 1 as const, heroId: null, isQuitter: true },
      { playerId: 'a', slot: 2, team: 1 as const, heroId: null, isQuitter: false },
      { playerId: 'b', slot: 7, team: 2 as const, heroId: null, isQuitter: false },
    ];
    const start = new Map([
      ['quit', { mu: 25, sigma: 8.333 }],
      ['a', { mu: 25, sigma: 8.333 }],
      ['b', { mu: 25, sigma: 8.333 }],
    ]);
    const full = simulatePostMatchRatings(entries, 1, start, new Map());
    const soft = simulatePostMatchRatings(entries, 1, start, new Map(), new Map(), 50);

    expect(soft.globalByPlayer.get('quit')!.mu).toBeCloseTo(full.globalByPlayer.get('quit')!.mu, 8);
  });
});
