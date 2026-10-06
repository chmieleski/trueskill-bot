import { describe, expect, it } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';
import { computeWinChanceFromRatings } from '../rating/rating-preview.js';
import {
  BALANCE_TARGET_IMBALANCE,
  findBalancedRoster,
  type BalanceRatingLookup,
  type BalanceRosterEntry,
  type MuSigma,
} from './lobby-balance.js';

const DEFAULT: MuSigma = { mu: 25, sigma: 8.333 };

function lookupFromMaps(
  globals: Record<string, MuSigma>,
  heroes: Record<string, MuSigma> = {},
): BalanceRatingLookup {
  return {
    global: (playerId) => globals[playerId] ?? DEFAULT,
    hero: (playerId, heroId) => heroes[`${playerId}:${heroId}`] ?? DEFAULT,
  };
}

/** Deterministic RNG (mulberry32) so tests are reproducible. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seat(playerId: string, slot: number, extra: Partial<BalanceRosterEntry> = {}) {
  return {
    playerId,
    slot,
    team: slot <= 6 ? 1 : 2,
    heroId: slot,
    nick: playerId,
    ...extra,
  } as BalanceRosterEntry;
}

function seating(roster: BalanceRosterEntry[]): string {
  return roster.map((entry) => `${entry.slot}:${entry.playerId}`).join('|');
}

/** Stacked 6v6: strong players all on team A. */
const STACKED: BalanceRosterEntry[] = [
  seat('s1', 1),
  seat('s2', 2),
  seat('s3', 3),
  seat('m1', 4),
  seat('m2', 5),
  seat('m3', 6),
  seat('w1', 7),
  seat('w2', 8),
  seat('w3', 9),
  seat('n1', 10),
  seat('n2', 11),
  seat('n3', 12),
];
const STACKED_LOOKUP = lookupFromMaps({
  s1: { mu: 35, sigma: 3 },
  s2: { mu: 33, sigma: 3 },
  s3: { mu: 31, sigma: 3 },
  m1: { mu: 28, sigma: 3 },
  m2: { mu: 27, sigma: 3 },
  m3: { mu: 26, sigma: 3 },
  w1: { mu: 24, sigma: 3 },
  w2: { mu: 23, sigma: 3 },
  w3: { mu: 22, sigma: 3 },
  n1: { mu: 20, sigma: 3 },
  n2: { mu: 19, sigma: 3 },
  n3: { mu: 18, sigma: 3 },
});

describe('findBalancedRoster', () => {
  it('reaches 50/50 or 51/49 on a stacked lobby', () => {
    const result = findBalancedRoster(STACKED, STACKED_LOOKUP, undefined, undefined, seeded(1));
    expect(result).toBeDefined();
    expect(result!.balanced).toBe(true);
    expect(Math.abs(50 - result!.winChance.teamAPercent)).toBeLessThanOrEqual(
      BALANCE_TARGET_IMBALANCE,
    );
    expect(result!.roster.map((e) => e.playerId).sort()).toEqual(
      STACKED.map((e) => e.playerId).sort(),
    );
  });

  it('returns a different balanced combination on another click', () => {
    const first = findBalancedRoster(STACKED, STACKED_LOOKUP, undefined, undefined, seeded(1))!;
    const second = findBalancedRoster(
      first.roster,
      STACKED_LOOKUP,
      undefined,
      undefined,
      seeded(2),
    )!;
    expect(second.balanced).toBe(true);
    expect(seating(second.roster)).not.toBe(seating(first.roster));
  });

  it('never moves locked seats', () => {
    const roster = STACKED.map((e) => (e.slot === 1 || e.slot === 7 ? { ...e, locked: true } : e));
    const result = findBalancedRoster(roster, STACKED_LOOKUP, undefined, undefined, seeded(3))!;
    expect(result.balanced).toBe(true);
    expect(result.roster.find((e) => e.slot === 1)?.playerId).toBe('s1');
    expect(result.roster.find((e) => e.slot === 7)?.playerId).toBe('w1');
    expect(result.roster.filter((e) => e.locked === true)).toHaveLength(2);
  });

  it('may use empty slots but keeps both teams populated and within the profile', () => {
    const wos = getGameProfile(WARCRAFT3_WOS_GAME_ID);
    const roster: BalanceRosterEntry[] = [
      { ...seat('s1', 1), team: 1 },
      { ...seat('s2', 2), team: 1 },
      { ...seat('w1', 6), team: 2 },
    ];
    const lookup = lookupFromMaps({
      s1: { mu: 30, sigma: 3 },
      s2: { mu: 30, sigma: 3 },
      w1: { mu: 20, sigma: 3 },
    });
    for (let seed = 1; seed <= 5; seed += 1) {
      const result = findBalancedRoster(roster, lookup, undefined, wos, seeded(seed));
      expect(result).toBeDefined();
      const teams = new Set(result!.roster.map((e) => e.team));
      expect(teams).toEqual(new Set([1, 2]));
      expect(result!.roster.every((e) => e.slot >= 1 && e.slot <= wos.slotCount)).toBe(true);
    }
  });

  it('falls back to the closest seating when 49–51 is unreachable', () => {
    const roster = [seat('pro', 1), seat('a', 2), seat('b', 7)];
    const lookup = lookupFromMaps({ pro: { mu: 45, sigma: 1 }, b: { mu: 10, sigma: 1 } });
    const result = findBalancedRoster(roster, lookup, undefined, undefined, seeded(4))!;
    expect(result.balanced).toBe(false);
    const teamOf = (id: string) => result.roster.find((e) => e.playerId === id)!.team;
    expect(teamOf('pro')).not.toBe(teamOf('a'));
  });

  it('returns undefined when every seat is locked', () => {
    const roster = [seat('a', 1, { locked: true }), seat('b', 7, { locked: true })];
    expect(findBalancedRoster(roster, lookupFromMaps({}))).toBeUndefined();
  });

  it('keeps isNewPlayer on moved seats so its win% matches a recompute', () => {
    const roster = [
      seat('v1', 1),
      seat('v2', 2),
      seat('v3', 3),
      seat('b1', 7),
      seat('new', 8, { isNewPlayer: true }),
    ];
    const globals = new Map<string, MuSigma>([
      ['v1', { mu: 30, sigma: 3 }],
      ['v2', { mu: 30, sigma: 3 }],
      ['v3', { mu: 30, sigma: 3 }],
      ['b1', { mu: 30, sigma: 3 }],
    ]);
    const lookup: BalanceRatingLookup = {
      global: (playerId) => globals.get(playerId) ?? DEFAULT,
      hero: () => DEFAULT,
    };
    const result = findBalancedRoster(roster, lookup, { staticSigma: true }, undefined, seeded(5))!;
    expect(result.roster.find((e) => e.playerId === 'new')?.isNewPlayer).toBe(true);
    const recomputed = computeWinChanceFromRatings(result.roster, globals, new Map(), {
      staticSigma: true,
    });
    expect(recomputed).toEqual(result.winChance);
  });
});
