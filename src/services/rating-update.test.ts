import { rating } from 'openskill';
import { describe, expect, it } from 'vitest';
import { MatchServiceError } from './match-service.js';
import {
  applySyntheticLosses,
  assertBothTeamsHaveActivePlayers,
  buildDummyOpponentTeam,
  partitionRosterForRating,
  QUITTER_SYNTHETIC_LOSSES,
} from './rating-update.js';

describe('QUITTER_SYNTHETIC_LOSSES', () => {
  it('uses the configured quitter penalty count', () => {
    expect(QUITTER_SYNTHETIC_LOSSES).toBe(3);
  });
});

describe('buildDummyOpponentTeam', () => {
  it('builds the fixed strong dummy team', () => {
    const dummy = buildDummyOpponentTeam();

    expect(dummy).toHaveLength(2);
    expect(dummy[0]!.mu).toBe(40);
    expect(dummy[0]!.sigma).toBe(4);
    expect(dummy[1]!.mu).toBe(40);
    expect(dummy[1]!.sigma).toBe(4);
  });
});

describe('applySyntheticLosses', () => {
  it('lowers the player team after repeated losses', () => {
    const before = [
      rating({ mu: 25, sigma: 8.333 }),
      rating({ mu: 25, sigma: 8.333 }),
    ];

    const after = applySyntheticLosses(before);

    expect(after).toHaveLength(2);
    expect(after[0]!.mu).toBeLessThan(before[0]!.mu);
    expect(after[1]!.mu).toBeLessThan(before[1]!.mu);
  });
});

describe('partitionRosterForRating', () => {
  it('splits quitters from active entries', () => {
    const { quitters, active } = partitionRosterForRating([
      { slot: 1, isQuitter: true },
      { slot: 2, isQuitter: false },
      { slot: 7, isQuitter: false },
    ]);

    expect(quitters.map((entry) => entry.slot)).toEqual([1]);
    expect(active.map((entry) => entry.slot)).toEqual([2, 7]);
  });
});

describe('assertBothTeamsHaveActivePlayers', () => {
  it('accepts one active player per team', () => {
    expect(() =>
      assertBothTeamsHaveActivePlayers([{ slot: 1 }, { slot: 7 }]),
    ).not.toThrow();
  });

  it('rejects when quitters empty a team', () => {
    expect(() => assertBothTeamsHaveActivePlayers([{ slot: 1 }])).toThrow(
      MatchServiceError,
    );
  });
});
