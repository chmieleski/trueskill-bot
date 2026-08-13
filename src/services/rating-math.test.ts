import { describe, expect, it } from 'vitest';
import {
  displayOrdinal,
  roundWinPercents,
  splitRosterByTeam,
  toOpenSkillRatings,
} from './rating-math.js';

describe('displayOrdinal', () => {
  it('returns display ki: OFFSET + SCALE * (mu - 3*sigma)', () => {
    // cold start: ordinal ≈ 0 → 1000 ki
    expect(displayOrdinal(25, 8.333)).toBe(1000);
    // solid: ordinal 24 → 1000 + 200*24 = 5800
    expect(displayOrdinal(30, 2)).toBe(5800);
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
