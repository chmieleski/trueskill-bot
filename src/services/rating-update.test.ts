import { describe, expect, it } from 'vitest';
import { rating } from 'openskill';
import {
  QUITTER_SYNTHETIC_LOSSES,
  applySyntheticLosses,
  assertBothTeamsHaveActivePlayers,
  buildDummyOpponentTeam,
  partitionRosterForRating,
} from './rating-update.js';
import { MatchServiceError } from './match-service.js';

describe('applySyntheticLosses', () => {
  it('lowers mu over N synthetic losses', () => {
    const before = [rating({ mu: 25, sigma: 8.333 }), rating({ mu: 25, sigma: 8.333 })];
    const after = applySyntheticLosses(before, QUITTER_SYNTHETIC_LOSSES);
    expect(after).toHaveLength(2);
    expect(after[0]!.mu).toBeLessThan(before[0]!.mu);
    expect(after[1]!.mu).toBeLessThan(before[1]!.mu);
  });

  it('uses default N=3', () => {
    expect(QUITTER_SYNTHETIC_LOSSES).toBe(3);
  });
});

describe('buildDummyOpponentTeam', () => {
  it('returns a non-empty strong team', () => {
    const dummy = buildDummyOpponentTeam();
    expect(dummy.length).toBeGreaterThanOrEqual(2);
    expect(dummy[0]!.mu).toBeGreaterThan(25);
  });
});

describe('partitionRosterForRating', () => {
  it('splits quitters from active', () => {
    const { quitters, active } = partitionRosterForRating([
      { slot: 1, isQuitter: true },
      { slot: 7, isQuitter: false },
    ]);
    expect(quitters.map((e) => e.slot)).toEqual([1]);
    expect(active.map((e) => e.slot)).toEqual([7]);
  });
});

describe('assertBothTeamsHaveActivePlayers', () => {
  it('throws when a team has zero active players', () => {
    expect(() =>
      assertBothTeamsHaveActivePlayers([{ slot: 1 }, { slot: 2 }]),
    ).toThrow(MatchServiceError);
  });

  it('passes when both teams have at least one', () => {
    expect(() =>
      assertBothTeamsHaveActivePlayers([{ slot: 1 }, { slot: 7 }]),
    ).not.toThrow();
  });
});
