import { describe, expect, it } from 'vitest';
import {
  compareSuggestions,
  formatBalanceHint,
  isUnbalancedWinChance,
  suggestBalanceMove,
  type BalanceRatingLookup,
  type BalanceRosterEntry,
  type MuSigma,
} from './lobby-balance.js';

const DEFAULT: MuSigma = { mu: 25, sigma: 8.333 };

function lookupFromMaps(
  globals: Record<string, MuSigma>,
  heroes: Record<string, MuSigma>,
): BalanceRatingLookup {
  return {
    global: (playerId) => globals[playerId] ?? DEFAULT,
    hero: (playerId, heroId) => heroes[`${playerId}:${heroId}`] ?? DEFAULT,
  };
}

describe('isUnbalancedWinChance', () => {
  it('is true outside 45–55 inclusive band edges', () => {
    expect(isUnbalancedWinChance(44)).toBe(true);
    expect(isUnbalancedWinChance(56)).toBe(true);
    expect(isUnbalancedWinChance(45)).toBe(false);
    expect(isUnbalancedWinChance(55)).toBe(false);
    expect(isUnbalancedWinChance(50)).toBe(false);
  });
});

describe('suggestBalanceMove', () => {
  it('returns undefined when current win chance is balanced', () => {
    const roster: BalanceRosterEntry[] = [
      { playerId: 'a', slot: 1, heroId: 1, nick: 'Alice' },
      { playerId: 'b', slot: 7, heroId: 7, nick: 'Bob' },
    ];
    const lookup = lookupFromMaps({}, {});
    expect(
      suggestBalanceMove(roster, lookup, { teamAPercent: 50, teamBPercent: 50 }),
    ).toBeUndefined();
  });

  it('returns undefined when all players are on one team even if win chance is unbalanced', () => {
    const roster: BalanceRosterEntry[] = [
      { playerId: 'a', slot: 1, heroId: 1, nick: 'Alice' },
      { playerId: 'b', slot: 2, heroId: 2, nick: 'Bob' },
    ];
    const lookup = lookupFromMaps({}, {});
    expect(
      suggestBalanceMove(roster, lookup, { teamAPercent: 90, teamBPercent: 10 }),
    ).toBeUndefined();
  });

  it('rejects moves that would empty a team', () => {
    // 1v2: only A player moving to B empty slot would empty A — must not suggest that
    // unless a swap exists. With one on A, swaps are possible with B players.
    const roster: BalanceRosterEntry[] = [
      { playerId: 'strong', slot: 1, heroId: 1, nick: 'Strong' },
      { playerId: 'w1', slot: 7, heroId: 7, nick: 'Weak1' },
      { playerId: 'w2', slot: 8, heroId: 8, nick: 'Weak2' },
    ];
    const lookup = lookupFromMaps(
      {
        strong: { mu: 40, sigma: 2 },
        w1: { mu: 20, sigma: 8 },
        w2: { mu: 20, sigma: 8 },
      },
      {},
    );
    const suggestion = suggestBalanceMove(roster, lookup, {
      teamAPercent: 90,
      teamBPercent: 10,
    });
    // If a suggestion exists, both teams must still have ≥1 after applying it
    if (suggestion) {
      const next = new Map(roster.map((e) => [e.slot, e]));
      if (suggestion.kind === 'move') {
        const moving = next.get(suggestion.fromSlot)!;
        next.delete(suggestion.fromSlot);
        next.set(suggestion.toSlot, { ...moving, slot: suggestion.toSlot, heroId: suggestion.toSlot });
      } else {
        const a = next.get(suggestion.fromSlot)!;
        const b = next.get(suggestion.toSlot)!;
        next.set(suggestion.fromSlot, { ...b, slot: suggestion.fromSlot, heroId: suggestion.fromSlot });
        next.set(suggestion.toSlot, { ...a, slot: suggestion.toSlot, heroId: suggestion.toSlot });
      }
      const teamA = [...next.values()].filter((e) => e.slot <= 6);
      const teamB = [...next.values()].filter((e) => e.slot > 6);
      expect(teamA.length).toBeGreaterThanOrEqual(1);
      expect(teamB.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('prefers an improving swap when it beats staying put', () => {
    // 2v2 skew: Strong+WeakA on A vs Weak1+Mid on B → swap Strong with Mid improves
    const roster: BalanceRosterEntry[] = [
      { playerId: 'strong', slot: 1, heroId: 1, nick: 'Strong' },
      { playerId: 'weakA', slot: 2, heroId: 2, nick: 'WeakA' },
      { playerId: 'w1', slot: 7, heroId: 7, nick: 'Weak1' },
      { playerId: 'mid', slot: 8, heroId: 8, nick: 'Mid' },
    ];
    const lookup = lookupFromMaps(
      {
        strong: { mu: 40, sigma: 2 },
        weakA: { mu: 18, sigma: 8 },
        w1: { mu: 18, sigma: 8 },
        mid: { mu: 25, sigma: 5 },
      },
      {},
    );
    const suggestion = suggestBalanceMove(roster, lookup, {
      teamAPercent: 85,
      teamBPercent: 15,
    });
    expect(suggestion).toBeDefined();
    expect(suggestion!.kind).toBe('swap');
    expect(suggestion!.fromNick).toBe('Strong');
    expect(suggestion!.resultingWinChance.teamAPercent + suggestion!.resultingWinChance.teamBPercent).toBe(100);
    const imbalance = Math.abs(50 - suggestion!.resultingWinChance.teamAPercent);
    expect(imbalance).toBeLessThan(Math.abs(50 - 85));
  });

  it('can suggest a move into an empty slot when that improves balance', () => {
    // 1v3 skew: moving one B player onto empty A slot can help
    const roster: BalanceRosterEntry[] = [
      { playerId: 'a1', slot: 1, heroId: 1, nick: 'A1' },
      { playerId: 'b1', slot: 7, heroId: 7, nick: 'B1' },
      { playerId: 'b2', slot: 8, heroId: 8, nick: 'B2' },
      { playerId: 'b3', slot: 9, heroId: 9, nick: 'B3' },
    ];
    const lookup = lookupFromMaps(
      {
        a1: { mu: 22, sigma: 6 },
        b1: { mu: 30, sigma: 4 },
        b2: { mu: 30, sigma: 4 },
        b3: { mu: 30, sigma: 4 },
      },
      {},
    );
    const suggestion = suggestBalanceMove(roster, lookup, {
      teamAPercent: 20,
      teamBPercent: 80,
    });
    expect(suggestion).toBeDefined();
    expect(
      Math.abs(50 - suggestion!.resultingWinChance.teamAPercent),
    ).toBeLessThan(Math.abs(50 - 20));
  });

  it('compareSuggestions prefers swap over move, then lower fromSlot', () => {
    const base = {
      resultingWinChance: { teamAPercent: 52, teamBPercent: 48 },
      fromNick: 'x',
    };
    const swap = { ...base, kind: 'swap' as const, fromSlot: 2, toSlot: 9, toNick: 'y' };
    const move = { ...base, kind: 'move' as const, fromSlot: 1, toSlot: 10 };
    expect(compareSuggestions(swap, move)).toBeLessThan(0);

    const swapHigh = { ...swap, fromSlot: 3 };
    const swapLow = { ...swap, fromSlot: 1 };
    expect(compareSuggestions(swapLow, swapHigh)).toBeLessThan(0);
  });
});

describe('formatBalanceHint', () => {
  it('formats swap and move lines', () => {
    expect(
      formatBalanceHint({
        kind: 'swap',
        fromSlot: 3,
        toSlot: 9,
        fromNick: 'Alice',
        toNick: 'Bob',
        resultingWinChance: { teamAPercent: 52, teamBPercent: 48 },
      }),
    ).toBe('Swap Alice (3) ↔ Bob (9) → ~52% / 48%');

    expect(
      formatBalanceHint({
        kind: 'move',
        fromSlot: 3,
        toSlot: 10,
        fromNick: 'Alice',
        resultingWinChance: { teamAPercent: 51, teamBPercent: 49 },
      }),
    ).toBe('Move Alice (3) → slot 10 → ~51% / 49%');
  });
});
