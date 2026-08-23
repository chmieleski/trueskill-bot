import { rating } from 'openskill';
import { describe, expect, it, vi } from 'vitest';
import { MatchServiceError } from '../match/match-service.js';
import { ensurePlayerRatings } from './rating-preview.js';
import {
  applyGrieferPenalties,
  applyMatchRatings,
  applyQuitterPenalties,
  applySyntheticLosses,
  assertBothTeamsHaveActivePlayers,
  buildDummyOpponentTeam,
  canRunHeroRate,
  canRunTeamRate,
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
  it('splits quitters from rateable veterans', () => {
    const { quitters, newNonQuit, activeRateable } = partitionRosterForRating([
      { slot: 1, isQuitter: true },
      { slot: 2, isQuitter: false },
      { slot: 7, isQuitter: false },
    ]);

    expect(quitters.map((entry) => entry.slot)).toEqual([1]);
    expect(newNonQuit).toEqual([]);
    expect(activeRateable.map((entry) => entry.slot)).toEqual([2, 7]);
  });

  it('keeps griefers in the rateable roster when not New', () => {
    const { quitters, newNonQuit, activeRateable } = partitionRosterForRating([
      { slot: 1, isQuitter: false },
      { slot: 2, isQuitter: false },
    ]);

    expect(quitters).toEqual([]);
    expect(newNonQuit).toEqual([]);
    expect(activeRateable.map((entry) => entry.slot)).toEqual([1, 2]);
  });

  it('puts non-quit New into newNonQuit and veterans into activeRateable', () => {
    const { quitters, newNonQuit, activeRateable } = partitionRosterForRating([
      { slot: 1, isQuitter: false, wasNewPlayer: true },
      { slot: 2, isQuitter: false, wasNewPlayer: false },
      { slot: 7, isQuitter: true, wasNewPlayer: true },
    ]);

    expect(newNonQuit.map((entry) => entry.slot)).toEqual([1]);
    expect(activeRateable.map((entry) => entry.slot)).toEqual([2]);
    expect(quitters.map((entry) => entry.slot)).toEqual([7]);
  });

  it('treats missing wasNewPlayer as not New', () => {
    const { newNonQuit, activeRateable } = partitionRosterForRating([
      { slot: 1, isQuitter: false },
      { slot: 2, isQuitter: false, wasNewPlayer: false },
    ]);

    expect(newNonQuit).toEqual([]);
    expect(activeRateable.map((entry) => entry.slot)).toEqual([1, 2]);
  });
});

describe('canRunTeamRate', () => {
  it('requires at least one rateable player on each team', () => {
    expect(canRunTeamRate([{ team: 1 }, { team: 2 }])).toBe(true);
    expect(canRunTeamRate([{ team: 1 }])).toBe(false);
    expect(canRunTeamRate([])).toBe(false);
  });
});

describe('canRunHeroRate', () => {
  it('requires at least one hero seat on each team', () => {
    expect(
      canRunHeroRate([
        { team: 1, heroId: 1 },
        { team: 2, heroId: 7 },
      ]),
    ).toBe(true);
    expect(
      canRunHeroRate([
        { team: 1, heroId: null },
        { team: 2, heroId: 7 },
      ]),
    ).toBe(false);
    expect(
      canRunHeroRate([
        { team: 1, heroId: 1 },
        { team: 2, heroId: null },
      ]),
    ).toBe(false);
    expect(canRunHeroRate([])).toBe(false);
  });

  it('allows mixed ACA + hero when both teams still have a hero', () => {
    expect(
      canRunHeroRate([
        { team: 1, heroId: null },
        { team: 1, heroId: 2 },
        { team: 2, heroId: 7 },
      ]),
    ).toBe(true);
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

const COMPLETED_AT = new Date('2026-08-23T12:00:00.000Z');

const activityResetData = {
  lastQualifyingActivityAt: COMPLETED_AT,
  idleDecayKiApplied: 0,
  lastDecayAppliedAt: null,
};

describe('applyMatchRatings', () => {
  it('updates global ratings only when heroId is null', async () => {
    const db = heroNullDb();

    await applyMatchRatings('league-1', heroNullOneVOne, 1, COMPLETED_AT, db as never);

    expect(db.playerHeroRating.findMany).not.toHaveBeenCalled();
    expect(db.playerHeroRating.update).not.toHaveBeenCalled();
    expect(db.playerHeroRating.createMany).not.toHaveBeenCalled();
    expect(db.playerRating.update).toHaveBeenCalled();
  });

  it('resets idle decay streak on non-quit PlayerRating updates', async () => {
    const db = heroNullDb();

    await applyMatchRatings('league-1', heroNullOneVOne, 1, COMPLETED_AT, db as never);

    expect(db.playerRating.update).toHaveBeenCalledTimes(2);
    for (const call of db.playerRating.update.mock.calls) {
      expect(call[0].data).toMatchObject(activityResetData);
      expect(call[0].data).toHaveProperty('mu');
      expect(call[0].data).toHaveProperty('sigma');
    }
  });

  it('does not reset idle decay streak for quitters', async () => {
    const db = heroNullDb();
    db.playerRating.findMany.mockResolvedValue([
      { playerId: 'p1', mu: 25, sigma: 8.333 },
      { playerId: 'p2', mu: 25, sigma: 8.333 },
      { playerId: 'p3', mu: 25, sigma: 8.333 },
    ]);
    const roster: RatingRosterEntry[] = [
      { playerId: 'p1', slot: 1, team: 1, heroId: null, isQuitter: false },
      { playerId: 'p2', slot: 6, team: 2, heroId: null, isQuitter: false },
      { playerId: 'p3', slot: 7, team: 2, heroId: null, isQuitter: true },
    ];

    await applyMatchRatings('league-1', roster, 1, COMPLETED_AT, db as never);

    const updatedPlayerIds = db.playerRating.update.mock.calls.map(
      (call) => call[0].where.leagueId_playerId.playerId as string,
    );
    expect(updatedPlayerIds).toEqual(expect.arrayContaining(['p1', 'p2']));
    expect(updatedPlayerIds).not.toContain('p3');
    for (const call of db.playerRating.update.mock.calls) {
      expect(call[0].data).toMatchObject(activityResetData);
    }
  });

  it('resets idle decay streak even when New freeze skips team rate', async () => {
    const db = heroNullDb();
    const roster: RatingRosterEntry[] = [
      { playerId: 'p1', slot: 1, team: 1, heroId: null, isQuitter: false, wasNewPlayer: true },
      { playerId: 'p2', slot: 6, team: 2, heroId: null, isQuitter: false, wasNewPlayer: false },
    ];

    await expect(
      applyMatchRatings('league-1', roster, 1, COMPLETED_AT, db as never),
    ).resolves.toBeUndefined();

    expect(db.playerRating.update).toHaveBeenCalledTimes(2);
    for (const call of db.playerRating.update.mock.calls) {
      expect(call[0].data).toEqual(activityResetData);
    }
  });

  it('does not write hero ratings when one team has no hero seats', async () => {
    const playerRating = {
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
      findMany: vi.fn().mockResolvedValue([
        { playerId: 'p1', mu: 25, sigma: 8.333 },
        { playerId: 'p2', mu: 25, sigma: 8.333 },
      ]),
      update: vi.fn().mockResolvedValue({}),
    };
    const playerHeroRating = {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([{ playerId: 'p2', heroId: 7, mu: 28, sigma: 7 }]),
      update: vi.fn().mockResolvedValue({}),
    };
    const db = {
      playerRating,
      playerHeroRating,
      matchPlayer: { findMany: vi.fn().mockResolvedValue([]) },
      playerRankReset: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const roster: RatingRosterEntry[] = [
      { playerId: 'p1', slot: 1, team: 1, heroId: null, isQuitter: false },
      { playerId: 'p2', slot: 7, team: 2, heroId: 7, isQuitter: false },
    ];

    await applyMatchRatings('league-1', roster, 1, COMPLETED_AT, db as never);

    expect(playerRating.update).toHaveBeenCalled();
    expect(playerHeroRating.update).not.toHaveBeenCalled();
  });
});

describe('applyGrieferPenalties', () => {
  it('updates global ratings for a griefer with heroId null', async () => {
    const db = heroNullDb();

    await applyGrieferPenalties(
      'league-1',
      [{ playerId: 'p1', slot: 1, team: 1, heroId: null, isQuitter: false, isGriefer: true }],
      db as never,
    );

    expect(db.playerHeroRating.findMany).not.toHaveBeenCalled();
    expect(db.playerRating.update).toHaveBeenCalled();
  });

  it('skips griefer penalty when the player is also marked quitter', async () => {
    const db = heroNullDb();

    await applyGrieferPenalties(
      'league-1',
      [{ playerId: 'p1', slot: 1, team: 1, heroId: null, isQuitter: true, isGriefer: true }],
      db as never,
    );

    expect(db.playerRating.update).not.toHaveBeenCalled();
  });
});
