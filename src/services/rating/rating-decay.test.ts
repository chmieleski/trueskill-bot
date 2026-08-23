import { describe, expect, it } from 'vitest';
import {
  computeDecayDelta,
  dailyKiLoss,
  idleDaysSince,
  isLeagueInCrunch,
  isPrizeEligible,
  kiLossToMuDelta,
  muFloor,
  pendingUtcDaysToApply,
  resolveRankDecayFooter,
  RANK_CRUNCH_DECAY_FOOTER,
  RANK_IDLE_DECAY_FOOTER,
} from './rating-decay.js';
import { KI_SCALE } from './rating-math.js';

describe('dailyKiLoss mid-season', () => {
  it('uses grace and tiers', () => {
    expect(dailyKiLoss(10, false)).toBe(0);
    expect(dailyKiLoss(11, false)).toBe(50);
    expect(dailyKiLoss(19, false)).toBe(50);
    expect(dailyKiLoss(20, false)).toBe(100);
  });
});

describe('dailyKiLoss crunch', () => {
  it('uses shorter grace and 2x rates', () => {
    expect(dailyKiLoss(2, true)).toBe(0);
    expect(dailyKiLoss(3, true)).toBe(100);
    expect(dailyKiLoss(9, true)).toBe(100);
    expect(dailyKiLoss(10, true)).toBe(200);
  });
});

describe('kiLossToMuDelta', () => {
  it('maps ki to mu via KI_SCALE', () => {
    expect(kiLossToMuDelta(50)).toBe(-50 / KI_SCALE);
    expect(kiLossToMuDelta(100)).toBe(-100 / KI_SCALE);
  });
});

describe('computeDecayDelta', () => {
  it('caps mid-season streak at 1000 ki', () => {
    const r = computeDecayDelta({
      idleDays: 30,
      inCrunch: false,
      streakKiApplied: 950,
      mu: 40,
      sigma: 1.5,
      leagueGames: 50,
      utcDaysToApply: 1,
    });
    expect(r.kiAppliedThisPass).toBe(50);
    expect(r.streakKiApplied).toBe(1000);
  });

  it('applies no further mid-season decay at cap', () => {
    const r = computeDecayDelta({
      idleDays: 30,
      inCrunch: false,
      streakKiApplied: 1000,
      mu: 40,
      sigma: 1.5,
      leagueGames: 50,
      utcDaysToApply: 1,
    });
    expect(r.muDelta).toBe(0);
    expect(r.kiAppliedThisPass).toBe(0);
  });

  it('does not cap during crunch', () => {
    const r = computeDecayDelta({
      idleDays: 15,
      inCrunch: true,
      streakKiApplied: 1000,
      mu: 40,
      sigma: 1.5,
      leagueGames: 50,
      utcDaysToApply: 1,
    });
    expect(r.kiAppliedThisPass).toBe(200);
  });

  it('respects mu floor near 1000 ki', () => {
    const sigma = 2;
    const games = 50;
    const floor = muFloor(sigma, games);
    const r = computeDecayDelta({
      idleDays: 30,
      inCrunch: false,
      streakKiApplied: 0,
      mu: floor + 0.01,
      sigma,
      leagueGames: games,
      utcDaysToApply: 1,
    });
    expect(r.muDelta).toBeLessThanOrEqual(0);
    expect(floor + 0.01 + r.muDelta).toBeGreaterThanOrEqual(floor - 1e-9);
  });

  it('applies zero when utcDaysToApply is 0', () => {
    const r = computeDecayDelta({
      idleDays: 30,
      inCrunch: false,
      streakKiApplied: 0,
      mu: 40,
      sigma: 1.5,
      leagueGames: 50,
      utcDaysToApply: 0,
    });
    expect(r.muDelta).toBe(0);
  });
});

describe('isLeagueInCrunch', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');

  it('detects auto crunch from seasonEndsAt', () => {
    expect(
      isLeagueInCrunch(
        {
          status: 'ACTIVE',
          decayEnabled: true,
          seasonEndsAt: new Date('2026-08-23T00:00:00.000Z'),
          crunchStartedAt: null,
        },
        now,
      ),
    ).toBe(true);
  });

  it('detects manual crunch', () => {
    expect(
      isLeagueInCrunch(
        {
          status: 'ACTIVE',
          decayEnabled: true,
          seasonEndsAt: null,
          crunchStartedAt: new Date('2026-08-18T00:00:00.000Z'),
        },
        now,
      ),
    ).toBe(true);
  });

  it('is false when decay disabled', () => {
    expect(
      isLeagueInCrunch(
        {
          status: 'ACTIVE',
          decayEnabled: false,
          seasonEndsAt: new Date('2026-08-23T00:00:00.000Z'),
          crunchStartedAt: null,
        },
        now,
      ),
    ).toBe(false);
  });
});

describe('isPrizeEligible', () => {
  it('requires activity within 7 days of seasonEndsAt', () => {
    const league = {
      status: 'ACTIVE' as const,
      decayEnabled: true,
      seasonEndsAt: new Date('2026-08-23T00:00:00.000Z'),
      crunchStartedAt: null,
      archivedAt: null,
    };
    const now = new Date('2026-08-20T12:00:00.000Z');
    expect(isPrizeEligible(new Date('2026-08-17T00:00:00.000Z'), league, now)).toBe(true);
    expect(isPrizeEligible(new Date('2026-08-15T00:00:00.000Z'), league, now)).toBe(false);
  });

  it('uses crunchStart when no seasonEndsAt', () => {
    const league = {
      status: 'ACTIVE' as const,
      decayEnabled: true,
      seasonEndsAt: null,
      crunchStartedAt: new Date('2026-08-18T00:00:00.000Z'),
      archivedAt: null,
    };
    const now = new Date('2026-08-20T12:00:00.000Z');
    expect(isPrizeEligible(new Date('2026-08-18T12:00:00.000Z'), league, now)).toBe(true);
    expect(isPrizeEligible(new Date('2026-08-17T00:00:00.000Z'), league, now)).toBe(false);
  });
});

describe('resolveRankDecayFooter', () => {
  const activeLeague = {
    status: 'ACTIVE',
    decayEnabled: true,
    seasonEndsAt: null,
    crunchStartedAt: null,
  };

  it('returns null when decay disabled, calibrating, or new', () => {
    expect(
      resolveRankDecayFooter({
        decayEnabled: false,
        leagueGames: 10,
        isNewPlayer: false,
        lastQualifyingActivityAt: new Date('2026-08-01T00:00:00.000Z'),
        league: activeLeague,
        now: new Date('2026-08-20T00:00:00.000Z'),
      }),
    ).toBeNull();
    expect(
      resolveRankDecayFooter({
        decayEnabled: true,
        leagueGames: 3,
        isNewPlayer: false,
        lastQualifyingActivityAt: new Date('2026-08-01T00:00:00.000Z'),
        league: activeLeague,
        now: new Date('2026-08-20T00:00:00.000Z'),
      }),
    ).toBeNull();
    expect(
      resolveRankDecayFooter({
        decayEnabled: true,
        leagueGames: 10,
        isNewPlayer: true,
        lastQualifyingActivityAt: new Date('2026-08-01T00:00:00.000Z'),
        league: activeLeague,
        now: new Date('2026-08-20T00:00:00.000Z'),
      }),
    ).toBeNull();
  });

  it('returns crunch footer when in crunch', () => {
    const now = new Date('2026-08-20T12:00:00.000Z');
    expect(
      resolveRankDecayFooter({
        decayEnabled: true,
        leagueGames: 10,
        isNewPlayer: false,
        lastQualifyingActivityAt: new Date('2026-08-19T00:00:00.000Z'),
        league: {
          ...activeLeague,
          crunchStartedAt: new Date('2026-08-18T00:00:00.000Z'),
        },
        now,
      }),
    ).toBe(RANK_CRUNCH_DECAY_FOOTER);
  });

  it('returns idle footer when idle > 10 days and not in crunch', () => {
    expect(
      resolveRankDecayFooter({
        decayEnabled: true,
        leagueGames: 10,
        isNewPlayer: false,
        lastQualifyingActivityAt: new Date('2026-08-01T00:00:00.000Z'),
        league: activeLeague,
        now: new Date('2026-08-20T00:00:00.000Z'),
      }),
    ).toBe(RANK_IDLE_DECAY_FOOTER);
  });

  it('returns null when idle within grace and not in crunch', () => {
    expect(
      resolveRankDecayFooter({
        decayEnabled: true,
        leagueGames: 10,
        isNewPlayer: false,
        lastQualifyingActivityAt: new Date('2026-08-15T00:00:00.000Z'),
        league: activeLeague,
        now: new Date('2026-08-20T00:00:00.000Z'),
      }),
    ).toBeNull();
  });
});

describe('idleDaysSince', () => {
  it('counts whole UTC days', () => {
    const a = new Date('2026-08-01T23:00:00.000Z');
    const b = new Date('2026-08-11T01:00:00.000Z');
    expect(idleDaysSince(a, b)).toBe(10);
  });
});

describe('pendingUtcDaysToApply', () => {
  it('is 0 on the same UTC day', () => {
    const d = new Date('2026-08-20T10:00:00.000Z');
    expect(pendingUtcDaysToApply(d, new Date('2026-08-01T00:00:00.000Z'), d)).toBe(0);
  });

  it('counts days since last apply', () => {
    expect(
      pendingUtcDaysToApply(
        new Date('2026-08-18T00:00:00.000Z'),
        new Date('2026-08-01T00:00:00.000Z'),
        new Date('2026-08-20T12:00:00.000Z'),
      ),
    ).toBe(2);
  });
});
