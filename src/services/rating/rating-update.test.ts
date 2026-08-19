import { rating } from 'openskill';
import { describe, expect, it, vi } from 'vitest';
import { MatchServiceError } from '../match/match-service.js';
import { ensurePlayerRatings } from './rating-preview.js';
import {
  applyMatchRatings,
  applyQuitterPenalties,
  applySyntheticLosses,
  assertBothTeamsHaveActivePlayers,
  buildDummyOpponentTeam,
  partitionRosterForRating,
  QUITTER_SYNTHETIC_LOSSES,
  type RatingRosterEntry,
} from './rating-update.js';

describe('QUITTER_SYNTHETIC_LOSSES', () => {
  it('uses one peer synthetic loss (heavier than a fair match loss in display ki)', () => {
    expect(QUITTER_SYNTHETIC_LOSSES).toBe(1);
  });
});

describe('buildDummyOpponentTeam', () => {
  it('mirrors the player team μ/σ (peer dummy, not a fixed strong opponent)', () => {
    const playerTeam = [rating({ mu: 28, sigma: 6 }), rating({ mu: 22, sigma: 7.5 })];
    const dummy = buildDummyOpponentTeam(playerTeam);

    expect(dummy).toHaveLength(2);
    expect(dummy[0]!.mu).toBe(28);
    expect(dummy[0]!.sigma).toBe(6);
    expect(dummy[1]!.mu).toBe(22);
    expect(dummy[1]!.sigma).toBe(7.5);
  });
});

describe('applySyntheticLosses', () => {
  it('lowers the player team after peer losses', () => {
    const before = [rating({ mu: 25, sigma: 8.333 }), rating({ mu: 25, sigma: 8.333 })];

    const after = applySyntheticLosses(before);

    expect(after).toHaveLength(2);
    expect(after[0]!.mu).toBeLessThan(before[0]!.mu);
    expect(after[1]!.mu).toBeLessThan(before[1]!.mu);
  });

  it('drops cold-start mu more than the old strong-dummy N=3 path (~23.55)', () => {
    const before = [rating({ mu: 25, sigma: 8.333 }), rating({ mu: 25, sigma: 8.333 })];

    const after = applySyntheticLosses(before);

    // Peer N=1 ≈ μ 23.04; strong dummy N=3 left ~23.55. Peer must hit harder.
    expect(after[0]!.mu).toBeLessThan(23.55);
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
      assertBothTeamsHaveActivePlayers([
        { slot: 1, team: 1 },
        { slot: 6, team: 2 },
      ]),
    ).not.toThrow();
  });

  it('rejects when quitters empty a team', () => {
    expect(() => assertBothTeamsHaveActivePlayers([{ slot: 1, team: 1 }])).toThrow(
      MatchServiceError,
    );
  });
});

describe('ensurePlayerRatings', () => {
  it('does not create PlayerHeroRating when heroId is null', async () => {
    const playerRating = { createMany: vi.fn().mockResolvedValue({ count: 2 }) };
    const playerHeroRating = { createMany: vi.fn() };

    await ensurePlayerRatings(
      'league-1',
      [
        { playerId: 'p1', heroId: null },
        { playerId: 'p2', heroId: null },
      ],
      { playerRating, playerHeroRating } as never,
    );

    expect(playerRating.createMany).toHaveBeenCalledOnce();
    expect(playerHeroRating.createMany).not.toHaveBeenCalled();
  });

  it('creates PlayerHeroRating only for non-null heroId', async () => {
    const playerRating = { createMany: vi.fn().mockResolvedValue({ count: 2 }) };
    const playerHeroRating = { createMany: vi.fn().mockResolvedValue({ count: 1 }) };

    await ensurePlayerRatings(
      'league-1',
      [
        { playerId: 'p1', heroId: null },
        { playerId: 'p2', heroId: 4 },
      ],
      { playerRating, playerHeroRating } as never,
    );

    expect(playerHeroRating.createMany).toHaveBeenCalledWith({
      data: [{ leagueId: 'league-1', playerId: 'p2', heroId: 4 }],
      skipDuplicates: true,
    });
  });
});

function heroNullDb() {
  const playerRating = {
    createMany: vi.fn().mockResolvedValue({ count: 2 }),
    findMany: vi.fn().mockResolvedValue([
      { playerId: 'p1', mu: 25, sigma: 8.333 },
      { playerId: 'p2', mu: 25, sigma: 8.333 },
    ]),
    update: vi.fn().mockResolvedValue({}),
  };
  const playerHeroRating = {
    createMany: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  };
  const matchPlayer = {
    findMany: vi.fn().mockResolvedValue([]),
  };
  const playerRankReset = {
    findMany: vi.fn().mockResolvedValue([]),
  };

  return { playerRating, playerHeroRating, matchPlayer, playerRankReset };
}

const heroNullOneVOne: RatingRosterEntry[] = [
  { playerId: 'p1', slot: 1, team: 1, heroId: null, isQuitter: false },
  { playerId: 'p2', slot: 6, team: 2, heroId: null, isQuitter: false },
];

describe('applyMatchRatings', () => {
  it('updates global ratings only when heroId is null', async () => {
    const db = heroNullDb();

    await applyMatchRatings('league-1', heroNullOneVOne, 1, db as never);

    expect(db.playerHeroRating.findMany).not.toHaveBeenCalled();
    expect(db.playerHeroRating.update).not.toHaveBeenCalled();
    expect(db.playerHeroRating.createMany).not.toHaveBeenCalled();
    expect(db.playerRating.update).toHaveBeenCalled();
  });
});

describe('applyQuitterPenalties', () => {
  it('updates global ratings only for a quitter with heroId null', async () => {
    const db = heroNullDb();

    await applyQuitterPenalties(
      'league-1',
      [{ playerId: 'p1', slot: 1, team: 1, heroId: null, isQuitter: true }],
      db as never,
    );

    expect(db.playerHeroRating.findMany).not.toHaveBeenCalled();
    expect(db.playerHeroRating.update).not.toHaveBeenCalled();
    expect(db.playerHeroRating.createMany).not.toHaveBeenCalled();
    expect(db.playerRating.update).toHaveBeenCalled();
  });
});
