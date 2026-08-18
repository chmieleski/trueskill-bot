import { describe, expect, it } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID } from '../../domain/games.js';
import {
  compareSuggestions,
  dedupeEmptySlotMoves,
  formatBalanceHint,
  formatBalanceHints,
  suggestBalanceMove,
  suggestBalanceMoves,
  type BalanceRatingLookup,
  type BalanceRosterEntry,
  type BalanceSuggestion,
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

describe('suggestBalanceMove', () => {
  it('returns undefined at 50/50 when no swap or move can improve', () => {
    const roster: BalanceRosterEntry[] = [
      { playerId: 'a', slot: 1, team: 1, heroId: 1, nick: 'Alice' },
      { playerId: 'b', slot: 7, team: 2, heroId: 7, nick: 'Bob' },
    ];
    const lookup = lookupFromMaps({}, {});
    expect(
      suggestBalanceMove(roster, lookup, { teamAPercent: 50, teamBPercent: 50 }),
    ).toBeUndefined();
  });

  it('still suggests when win chance is inside the old 45–55 band if a move improves', () => {
    const roster: BalanceRosterEntry[] = [
      { playerId: 's1', slot: 1, team: 1, heroId: 1, nick: 'S1' },
      { playerId: 's2', slot: 2, team: 1, heroId: 2, nick: 'S2' },
      { playerId: 'w1', slot: 3, team: 1, heroId: 3, nick: 'W1' },
      { playerId: 'm1', slot: 7, team: 2, heroId: 7, nick: 'M1' },
      { playerId: 'm2', slot: 8, team: 2, heroId: 8, nick: 'M2' },
      { playerId: 'm3', slot: 9, team: 2, heroId: 9, nick: 'M3' },
    ];
    const lookup = lookupFromMaps(
      {
        s1: { mu: 27, sigma: 3 },
        s2: { mu: 26, sigma: 3 },
        w1: { mu: 24, sigma: 6 },
        m1: { mu: 25, sigma: 5 },
        m2: { mu: 25, sigma: 5 },
        m3: { mu: 25, sigma: 5 },
      },
      {},
    );
    const suggestion = suggestBalanceMove(roster, lookup, {
      teamAPercent: 53,
      teamBPercent: 47,
    });
    expect(suggestion).toBeDefined();
    expect(suggestion!.kind).toBe('swap');
    expect(
      Math.abs(50 - suggestion!.resultingWinChance.teamAPercent),
    ).toBeLessThan(3);
  });

  it('returns undefined when all players are on one team even if win chance is unbalanced', () => {
    const roster: BalanceRosterEntry[] = [
      { playerId: 'a', slot: 1, team: 1, heroId: 1, nick: 'Alice' },
      { playerId: 'b', slot: 2, team: 1, heroId: 2, nick: 'Bob' },
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
      { playerId: 'strong', slot: 1, team: 1, heroId: 1, nick: 'Strong' },
      { playerId: 'w1', slot: 7, team: 2, heroId: 7, nick: 'Weak1' },
      { playerId: 'w2', slot: 8, team: 2, heroId: 8, nick: 'Weak2' },
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
        next.set(suggestion.toSlot, {
          ...moving,
          slot: suggestion.toSlot,
          heroId: suggestion.toSlot,
          team: suggestion.toSlot <= 6 ? 1 : 2,
        });
      } else {
        const a = next.get(suggestion.fromSlot)!;
        const b = next.get(suggestion.toSlot)!;
        next.set(suggestion.fromSlot, {
          ...b,
          slot: suggestion.fromSlot,
          heroId: suggestion.fromSlot,
          team: a.team,
        });
        next.set(suggestion.toSlot, {
          ...a,
          slot: suggestion.toSlot,
          heroId: suggestion.toSlot,
          team: b.team,
        });
      }
      const teamA = [...next.values()].filter((e) => e.team === 1);
      const teamB = [...next.values()].filter((e) => e.team === 2);
      expect(teamA.length).toBeGreaterThanOrEqual(1);
      expect(teamB.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('prefers an improving swap when it beats staying put', () => {
    // 2v2 skew: Strong+WeakA on A vs Weak1+Mid on B → swap Strong with Mid improves
    const roster: BalanceRosterEntry[] = [
      { playerId: 'strong', slot: 1, team: 1, heroId: 1, nick: 'Strong' },
      { playerId: 'weakA', slot: 2, team: 1, heroId: 2, nick: 'WeakA' },
      { playerId: 'w1', slot: 7, team: 2, heroId: 7, nick: 'Weak1' },
      { playerId: 'mid', slot: 8, team: 2, heroId: 8, nick: 'Mid' },
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
      { playerId: 'a1', slot: 1, team: 1, heroId: 1, nick: 'A1' },
      { playerId: 'b1', slot: 7, team: 2, heroId: 7, nick: 'B1' },
      { playerId: 'b2', slot: 8, team: 2, heroId: 8, nick: 'B2' },
      { playerId: 'b3', slot: 9, team: 2, heroId: 9, nick: 'B3' },
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

  it('never suggests ACA slots above 10', () => {
    const aca = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);
    const roster: BalanceRosterEntry[] = [
      { playerId: 'a1', slot: 1, team: 1, heroId: null, nick: 'A1' },
      { playerId: 'b1', slot: 6, team: 2, heroId: null, nick: 'B1' },
      { playerId: 'b2', slot: 7, team: 2, heroId: null, nick: 'B2' },
      { playerId: 'b3', slot: 8, team: 2, heroId: null, nick: 'B3' },
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
    const suggestion = suggestBalanceMove(
      roster,
      lookup,
      { teamAPercent: 20, teamBPercent: 80 },
      aca,
    );
    if (suggestion) {
      expect(suggestion.toSlot).toBeLessThanOrEqual(10);
      expect(suggestion.fromSlot).toBeLessThanOrEqual(10);
    }
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

  it('collapses same-player empty-slot moves into one suggestion', () => {
    const roster: BalanceRosterEntry[] = [
      { playerId: 'a1', slot: 1, team: 1, heroId: 1, nick: 'A1' },
      { playerId: 'chmieleski', slot: 7, team: 2, heroId: 7, nick: 'chmieleski' },
      { playerId: 'b2', slot: 8, team: 2, heroId: 8, nick: 'B2' },
      { playerId: 'b3', slot: 9, team: 2, heroId: 9, nick: 'B3' },
    ];
    const lookup = lookupFromMaps(
      {
        a1: { mu: 22, sigma: 6 },
        chmieleski: { mu: 35, sigma: 3 },
        b2: { mu: 30, sigma: 4 },
        b3: { mu: 30, sigma: 4 },
      },
      {},
    );
    const suggestions = suggestBalanceMoves(roster, lookup, {
      teamAPercent: 15,
      teamBPercent: 85,
    });
    const movesFromChmieleski = suggestions.filter(
      (s) => s.kind === 'move' && s.fromNick === 'chmieleski',
    );
    expect(movesFromChmieleski.length).toBeLessThanOrEqual(1);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });

  it('returns at most three distinct suggestions', () => {
    const roster: BalanceRosterEntry[] = [
      { playerId: 's1', slot: 1, team: 1, heroId: 1, nick: 'S1' },
      { playerId: 's2', slot: 2, team: 1, heroId: 2, nick: 'S2' },
      { playerId: 's3', slot: 3, team: 1, heroId: 3, nick: 'S3' },
      { playerId: 'w1', slot: 7, team: 2, heroId: 7, nick: 'W1' },
      { playerId: 'w2', slot: 8, team: 2, heroId: 8, nick: 'W2' },
      { playerId: 'w3', slot: 9, team: 2, heroId: 9, nick: 'W3' },
    ];
    const lookup = lookupFromMaps(
      {
        s1: { mu: 40, sigma: 2 },
        s2: { mu: 38, sigma: 2 },
        s3: { mu: 36, sigma: 2 },
        w1: { mu: 18, sigma: 8 },
        w2: { mu: 18, sigma: 8 },
        w3: { mu: 18, sigma: 8 },
      },
      {},
    );
    const suggestions = suggestBalanceMoves(roster, lookup, {
      teamAPercent: 90,
      teamBPercent: 10,
    });
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });
});

describe('dedupeEmptySlotMoves', () => {
  it('keeps one move per fromSlot and all swaps', () => {
    const baseWc = { teamAPercent: 52, teamBPercent: 48 };
    const candidates: BalanceSuggestion[] = [
      {
        kind: 'move',
        fromSlot: 7,
        toSlot: 6,
        fromNick: 'chmieleski',
        resultingWinChance: { teamAPercent: 48, teamBPercent: 52 },
      },
      {
        kind: 'move',
        fromSlot: 7,
        toSlot: 5,
        fromNick: 'chmieleski',
        resultingWinChance: { teamAPercent: 50, teamBPercent: 50 },
      },
      {
        kind: 'move',
        fromSlot: 7,
        toSlot: 4,
        fromNick: 'chmieleski',
        resultingWinChance: { teamAPercent: 49, teamBPercent: 51 },
      },
      {
        kind: 'swap',
        fromSlot: 1,
        toSlot: 8,
        fromNick: 'Alice',
        toNick: 'Bob',
        resultingWinChance: baseWc,
      },
    ];
    const deduped = dedupeEmptySlotMoves(candidates);
    const moves = deduped.filter((c) => c.kind === 'move');
    expect(moves).toHaveLength(1);
    expect(moves[0]!.toSlot).toBe(5); // perfect 50/50 beats 49/51
    expect(deduped.filter((c) => c.kind === 'swap')).toHaveLength(1);
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
    ).toBe('Move Alice (3) → empty slot 10 → ~51% / 49%');
  });

  it('numbers multiple hints', () => {
    expect(
      formatBalanceHints([
        {
          kind: 'swap',
          fromSlot: 1,
          toSlot: 7,
          fromNick: 'Alice',
          toNick: 'Bob',
          resultingWinChance: { teamAPercent: 52, teamBPercent: 48 },
        },
        {
          kind: 'move',
          fromSlot: 8,
          toSlot: 2,
          fromNick: 'Eve',
          resultingWinChance: { teamAPercent: 51, teamBPercent: 49 },
        },
      ]),
    ).toBe(
      '1. Swap Alice (1) ↔ Bob (7) → ~52% / 48%\n2. Move Eve (8) → empty slot 2 → ~51% / 49%',
    );
  });
});
