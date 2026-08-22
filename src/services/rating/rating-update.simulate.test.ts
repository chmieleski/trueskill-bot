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
