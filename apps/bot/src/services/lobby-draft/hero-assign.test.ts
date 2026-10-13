import { describe, expect, it } from 'vitest';
import { assignHeroes } from './hero-assign.js';

const HEROES = [1, 2, 3, 4, 5, 6];

describe('assignHeroes', () => {
  it('gives uncontested wishes as wanted', () => {
    const r = assignHeroes(
      [
        { key: 'a', wanted: [1] },
        { key: 'b', wanted: [2, 3] },
      ],
      HEROES,
    );
    expect(r.a).toEqual({ heroId: 1, how: 'wanted' });
    expect(r.b!.how).toBe('wanted');
    expect([2, 3]).toContain(r.b!.heroId);
  });

  it('satisfies both when a flexible player can step aside (A{1,2}, B{1})', () => {
    for (let i = 0; i < 50; i += 1) {
      const r = assignHeroes(
        [
          { key: 'a', wanted: [1, 2] },
          { key: 'b', wanted: [1] },
        ],
        HEROES,
      );
      expect(r.b!.heroId).toBe(1);
      expect(r.a!.heroId).toBe(2);
    }
  });

  it('true clash: one wins (contested), loser gets a random free hero', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const r = assignHeroes(
        [
          { key: 'a', wanted: [1] },
          { key: 'b', wanted: [1] },
        ],
        HEROES,
      );
      const winner = r.a!.heroId === 1 ? 'a' : 'b';
      const loser = winner === 'a' ? 'b' : 'a';
      expect(r[winner]).toEqual({ heroId: 1, how: 'contested' });
      expect(r[loser]!.how).toBe('random');
      expect(r[loser]!.heroId).not.toBe(1);
      seen.add(winner);
    }
    expect(seen).toEqual(new Set(['a', 'b']));
  });

  it('assigns every player a distinct side hero (6 players, empty prefs)', () => {
    const players = ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => ({ key, wanted: [] }));
    const r = assignHeroes(players, HEROES);
    expect(new Set(Object.values(r).map((x) => x.heroId))).toEqual(new Set(HEROES));
    expect(Object.values(r).every((x) => x.how === 'random')).toBe(true);
  });

  it('throws when the side cannot seat everyone', () => {
    const players = Array.from({ length: 7 }, (_, i) => ({ key: `p${i}`, wanted: [] }));
    expect(() => assignHeroes(players, HEROES)).toThrow();
  });
});

describe('weighted clashes', () => {
  /** Deterministic LCG so frequency checks don't flake. */
  function seeded(seed = 42): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 2 ** 32;
      return s / 2 ** 32;
    };
  }

  function winRate(weightA: number, weightB: number, runs = 4000): number {
    const rng = seeded();
    let aWins = 0;
    for (let i = 0; i < runs; i += 1) {
      const r = assignHeroes(
        [
          { key: 'a', wanted: [1], weight: weightA },
          { key: 'b', wanted: [1], weight: weightB },
        ],
        HEROES,
        rng,
      );
      if (r.a!.heroId === 1) aWins += 1;
    }
    return aWins / runs;
  }

  it('odds follow weight / Σweights (1 + losses)', () => {
    expect(winRate(1, 1)).toBeCloseTo(0.5, 1);
    expect(winRate(2, 1)).toBeCloseTo(2 / 3, 1);
    expect(winRate(4, 1)).toBeCloseTo(0.8, 1);
  });

  it('a big weight is never a guarantee in a clash', () => {
    const rate = winRate(50, 1);
    expect(rate).toBeGreaterThan(0.9);
    expect(rate).toBeLessThan(1);
  });

  it('a hero only one player wanted is always theirs, whatever the weights', () => {
    const rng = seeded(7);
    for (let i = 0; i < 200; i += 1) {
      const r = assignHeroes(
        [
          { key: 'a', wanted: [1], weight: 1 },
          { key: 'b', wanted: [2], weight: 50 },
        ],
        HEROES,
        rng,
      );
      expect(r.a!.heroId).toBe(1);
    }
  });
});
