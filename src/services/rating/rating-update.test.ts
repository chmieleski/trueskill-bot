import { rating } from 'openskill';
import { describe, expect, it, vi } from 'vitest';
import { MatchServiceError } from '../match/match-service.js';
import { ensurePlayerRatings } from './rating-preview.js';
import {
  accrueGrieferPenalties,
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
      { slot: 1, team: 1, isQuitter: true },
      { slot: 2, team: 1, isQuitter: false },
      { slot: 7, team: 2, isQuitter: false },
    ]);

    expect(quitters.map((entry) => entry.slot)).toEqual([1]);
    expect(newNonQuit).toEqual([]);
    expect(activeRateable.map((entry) => entry.slot)).toEqual([2, 7]);
  });

  it('keeps griefers in the rateable roster when not New', () => {
    const { quitters, newNonQuit, activeRateable } = partitionRosterForRating([
      { slot: 1, team: 1, isQuitter: false },
      { slot: 2, team: 1, isQuitter: false },
    ]);

    expect(quitters).toEqual([]);
    expect(newNonQuit).toEqual([]);
    expect(activeRateable.map((entry) => entry.slot)).toEqual([1, 2]);
  });

  it('freezes paired New (1v1) and leaves veterans rateable', () => {
    const { quitters, newNonQuit, activeRateable } = partitionRosterForRating([
      { slot: 1, team: 1 as const, isQuitter: false, wasNewPlayer: true },
      { slot: 2, team: 1 as const, isQuitter: false, wasNewPlayer: false },
      { slot: 7, team: 2 as const, isQuitter: false, wasNewPlayer: true },
      { slot: 8, team: 2 as const, isQuitter: false, wasNewPlayer: false },
    ]);

    expect(newNonQuit.map((entry) => entry.slot).sort()).toEqual([1, 7]);
    expect(activeRateable.map((entry) => entry.slot).sort()).toEqual([2, 8]);
    expect(quitters).toEqual([]);
  });

  it('rates one-sided New (k=0) instead of freezing', () => {
    const { newNonQuit, activeRateable, quitters } = partitionRosterForRating([
      { slot: 1, team: 1 as const, isQuitter: false, wasNewPlayer: false },
      { slot: 2, team: 1 as const, isQuitter: false, wasNewPlayer: false },
      { slot: 7, team: 2 as const, isQuitter: false, wasNewPlayer: true },
      { slot: 8, team: 2 as const, isQuitter: true, wasNewPlayer: true },
    ]);

    expect(newNonQuit).toEqual([]);
    expect(activeRateable.map((entry) => entry.slot).sort()).toEqual([1, 2, 7]);
    expect(quitters.map((entry) => entry.slot)).toEqual([8]);
  });

  it('freezes k lowest slots per team and rates excess New (2v1)', () => {
    const { newNonQuit, activeRateable } = partitionRosterForRating([
      { slot: 1, team: 1 as const, isQuitter: false, wasNewPlayer: true },
      { slot: 3, team: 1 as const, isQuitter: false, wasNewPlayer: true },
      { slot: 2, team: 1 as const, isQuitter: false, wasNewPlayer: false },
      { slot: 7, team: 2 as const, isQuitter: false, wasNewPlayer: true },
      { slot: 8, team: 2 as const, isQuitter: false, wasNewPlayer: false },
    ]);

    // k=1 → freeze slot 1 (lowest New on T1) and slot 7; excess New slot 3 rates
    expect(newNonQuit.map((entry) => entry.slot).sort()).toEqual([1, 7]);
    expect(activeRateable.map((entry) => entry.slot).sort()).toEqual([2, 3, 8]);
  });

  it('freezes surviving New when the paired New quit (balanced 1v1)', () => {
    const { newNonQuit, activeRateable, quitters } = partitionRosterForRating([
      { slot: 1, team: 1 as const, isQuitter: true, wasNewPlayer: true },
      { slot: 2, team: 1 as const, isQuitter: false, wasNewPlayer: false },
      { slot: 7, team: 2 as const, isQuitter: false, wasNewPlayer: true },
      { slot: 8, team: 2 as const, isQuitter: false, wasNewPlayer: false },
    ]);

    expect(quitters.map((entry) => entry.slot)).toEqual([1]);
    expect(newNonQuit.map((entry) => entry.slot)).toEqual([7]);
    expect(activeRateable.map((entry) => entry.slot).sort()).toEqual([2, 8]);
  });

  it('treats missing wasNewPlayer as not New', () => {
    const { newNonQuit, activeRateable } = partitionRosterForRating([
      { slot: 1, team: 1, isQuitter: false },
      { slot: 2, team: 1, isQuitter: false, wasNewPlayer: false },
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

  it('allows mixed WOS + hero when both teams still have a hero', () => {
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

  it('resets idle decay streak for frozen New who skip team rate', async () => {
    const db = heroNullDb();
    db.playerRating.findMany.mockResolvedValue([
      { playerId: 'new1', mu: 25, sigma: 8.333 },
      { playerId: 'vet1', mu: 32, sigma: 5 },
      { playerId: 'new2', mu: 25, sigma: 8.333 },
      { playerId: 'vet2', mu: 32, sigma: 5 },
    ]);
    const roster: RatingRosterEntry[] = [
      { playerId: 'new1', slot: 1, team: 1, heroId: null, isQuitter: false, wasNewPlayer: true },
      { playerId: 'vet1', slot: 2, team: 1, heroId: null, isQuitter: false, wasNewPlayer: false },
      { playerId: 'new2', slot: 7, team: 2, heroId: null, isQuitter: false, wasNewPlayer: true },
      { playerId: 'vet2', slot: 8, team: 2, heroId: null, isQuitter: false, wasNewPlayer: false },
    ];

    await applyMatchRatings('league-1', roster, 1, COMPLETED_AT, db as never);

    expect(db.playerRating.update).toHaveBeenCalledTimes(4);
    const updatesByPlayer = new Map(
      db.playerRating.update.mock.calls.map(
        (call) => [call[0].where.leagueId_playerId.playerId as string, call[0].data] as const,
      ),
    );
    expect(updatesByPlayer.get('new1')).toEqual(activityResetData);
    expect(updatesByPlayer.get('new2')).toEqual(activityResetData);
    expect(updatesByPlayer.get('vet1')).toMatchObject({
      ...activityResetData,
      mu: expect.any(Number),
      sigma: expect.any(Number),
    });
    expect(updatesByPlayer.get('vet2')).toMatchObject({
      ...activityResetData,
      mu: expect.any(Number),
      sigma: expect.any(Number),
    });
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

describe('accrueGrieferPenalties', () => {
  it('writes grieferKiAccrued without updating PlayerRating', async () => {
    const matchPlayerUpdate = vi.fn();
    const db = {
      matchPlayer: { update: matchPlayerUpdate },
    };

    await accrueGrieferPenalties(
      'match-1',
      [{ playerId: 'p1', slot: 1, team: 1, heroId: null, isQuitter: false, isGriefer: true }],
      new Map([['p1', { mu: 25, sigma: 8.333 }]]),
      new Map([['p1', 10]]),
      db as never,
    );

    expect(matchPlayerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ grieferKiAccrued: expect.any(Number) }),
      }),
    );
  });

  it('clears accrual when the player is not a griefer', async () => {
    const matchPlayerUpdate = vi.fn();
    const db = {
      matchPlayer: { update: matchPlayerUpdate },
    };

    await accrueGrieferPenalties(
      'match-1',
      [{ playerId: 'p1', slot: 1, team: 1, heroId: null, isQuitter: false, isGriefer: false }],
      new Map(),
      new Map(),
      db as never,
    );

    expect(matchPlayerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { grieferKiAccrued: null },
      }),
    );
  });

  it('skips griefer accrual when the player is also marked quitter', async () => {
    const matchPlayerUpdate = vi.fn();
    const db = {
      matchPlayer: { update: matchPlayerUpdate },
    };

    await accrueGrieferPenalties(
      'match-1',
      [{ playerId: 'p1', slot: 1, team: 1, heroId: null, isQuitter: true, isGriefer: true }],
      new Map([['p1', { mu: 25, sigma: 8.333 }]]),
      new Map([['p1', 10]]),
      db as never,
    );

    expect(matchPlayerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { grieferKiAccrued: null },
      }),
    );
  });
});
