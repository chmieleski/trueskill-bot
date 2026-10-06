import { describe, expect, it } from 'vitest';
import { pickRankHolders } from './pick-rank-holders.js';

const row = (discordId: string | null, ki: number, username: string, rank: number | null = 1) => ({
  discordId,
  ki,
  username,
  rank,
});

describe('pickRankHolders', () => {
  it('assigns positions 1–3 in leaderboard order', () => {
    const holders = pickRankHolders({
      entries: [row('a', 30, 'a'), row('b', 20, 'b'), row('c', 10, 'c'), row('d', 5, 'd')],
      incumbents: new Map(),
    });
    expect(holders).toEqual(
      new Map([
        [1, 'a'],
        [2, 'b'],
        [3, 'c'],
      ]),
    );
  });

  it('leaves a rank vacant when that player has no Discord link', () => {
    const holders = pickRankHolders({
      entries: [row(null, 30, 'a'), row('b', 20, 'b')],
      incumbents: new Map(),
    });
    expect(holders).toEqual(
      new Map([
        [1, null],
        [2, 'b'],
        [3, null],
      ]),
    );
  });

  it('skips calibrating rows (rank null)', () => {
    const holders = pickRankHolders({
      entries: [row('a', 30, 'a'), row('x', 99, 'x', null)],
      incumbents: new Map(),
    });
    expect(holders.get(1)).toBe('a');
    expect(holders.get(2)).toBeNull();
  });

  it('keeps incumbents on a ki tie', () => {
    const holders = pickRankHolders({
      entries: [row('a', 30, 'a'), row('b', 30, 'b'), row('c', 30, 'c')],
      incumbents: new Map([
        [1, 'c'],
        [2, 'a'],
      ]),
    });
    expect(holders).toEqual(
      new Map([
        [1, 'c'],
        [2, 'a'],
        [3, 'b'],
      ]),
    );
  });

  it('a tied incumbent outside the top 3 cutoff still wins the tie', () => {
    const holders = pickRankHolders({
      entries: [row('a', 30, 'a'), row('b', 20, 'b'), row('c', 10, 'c'), row('d', 10, 'd')],
      incumbents: new Map([[3, 'd']]),
    });
    expect(holders.get(3)).toBe('d');
  });
});
