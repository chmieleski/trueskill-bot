import { describe, expect, it } from 'vitest';
import {
  displayConservatismZ,
  displayOrdinal,
  KI_Z_BLEND_GAMES,
  KI_Z_END,
  KI_Z_START,
  roundWinPercents,
  splitRosterByTeam,
  toOpenSkillRatings,
} from './rating-math.js';

describe('displayConservatismZ', () => {
  it('starts at 3, ends at 2.5 after the blend window', () => {
    expect(displayConservatismZ(0)).toBe(KI_Z_START);
    expect(displayConservatismZ(KI_Z_BLEND_GAMES)).toBe(KI_Z_END);
    expect(displayConservatismZ(KI_Z_BLEND_GAMES + 10)).toBe(KI_Z_END);
  });

  it('blends linearly across the first 5 games', () => {
    expect(displayConservatismZ(1)).toBeCloseTo(2.9);
    expect(displayConservatismZ(2)).toBeCloseTo(2.8);
    expect(displayConservatismZ(3)).toBeCloseTo(2.7);
  });
});

describe('displayOrdinal', () => {
  it('returns cold-start ~1000 ki at 0 games (z=3)', () => {
    expect(displayOrdinal(25, 8.333)).toBe(1000);
    expect(displayOrdinal(25, 8.333, 0)).toBe(1000);
  });

  it('uses z=3 when matchesPlayed is omitted (legacy call sites)', () => {
    // ordinal 24 → 1000 + 200*24 = 5800
    expect(displayOrdinal(30, 2)).toBe(5800);
  });

  it('softens display after the blend window (z=2.5)', () => {
    // 1000 + 200 * (30 - 2.5*2) = 1000 + 5000 = 6000
    expect(displayOrdinal(30, 2, KI_Z_BLEND_GAMES)).toBe(6000);
  });

  it('lifts a mid 2-3 style rating above 1000 at 5 games', () => {
    // yomamma90-like: was ~844 at z=3; ~1658 at z=2.5
    expect(displayOrdinal(23.64, 8.14, 5)).toBe(1658);
  });
});

describe('roundWinPercents', () => {
  it('rounds so percents sum to 100', () => {
    expect(roundWinPercents(0.5, 0.5)).toEqual({ teamAPercent: 50, teamBPercent: 50 });
    const skewed = roundWinPercents(0.666, 0.334);
    expect(skewed.teamAPercent + skewed.teamBPercent).toBe(100);
  });
});

describe('splitRosterByTeam', () => {
  it('puts slots 1-6 in A and 7-12 in B', () => {
    const { teamA, teamB } = splitRosterByTeam([
      { slot: 7 },
      { slot: 1 },
      { slot: 12 },
    ]);
    expect(teamA.map((e) => e.slot)).toEqual([1]);
    expect(teamB.map((e) => e.slot)).toEqual([7, 12]);
  });
});

describe('toOpenSkillRatings', () => {
  it('preserves mu/sigma order for dual-entity arrays', () => {
    const ratings = toOpenSkillRatings([
      { mu: 25, sigma: 8.333 },
      { mu: 28, sigma: 7 },
    ]);
    expect(ratings).toHaveLength(2);
    expect(ratings[0]!.mu).toBe(25);
    expect(ratings[1]!.mu).toBe(28);
  });
});
