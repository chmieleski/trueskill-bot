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
