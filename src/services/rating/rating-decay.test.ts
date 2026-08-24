import { describe, expect, it } from 'vitest';
import {
  computeDecayDelta,
  dailyKiLoss,
  DEFAULT_DECAY_SETTINGS,
  idleDaysSince,
  isLeagueInCrunch,
  isPrizeEligibleFromGameCount,
  kiLossToMuDelta,
  muFloor,
  pendingUtcDaysToApply,
  resolveCrunchStart,
  resolvePrizeLockWindow,
  resolveRankDecayFooter,
  RANK_CRUNCH_DECAY_FOOTER,
  RANK_IDLE_DECAY_FOOTER,
} from './rating-decay.js';
import { KI_SCALE } from './rating-math.js';

describe('dailyKiLoss with custom settings', () => {
  it('uses overridden grace and rates', () => {
    const settings = {
      ...DEFAULT_DECAY_SETTINGS,
      midGraceDays: 5,
      midTier1Ki: 25,
      midTier1SpanDays: 2,
      midTier2Ki: 80,
    };
    expect(dailyKiLoss(5, false, settings)).toBe(0);
    expect(dailyKiLoss(6, false, settings)).toBe(25);
    expect(dailyKiLoss(7, false, settings)).toBe(25);
    expect(dailyKiLoss(8, false, settings)).toBe(80);
  });
});

describe('computeDecayDelta custom streak cap', () => {
  it('skips mid-season cap when midStreakCapKi is 0', () => {
    const r = computeDecayDelta({
      idleDays: 30,
      inCrunch: false,
      streakKiApplied: 5000,
      mu: 40,
      sigma: 1.5,
      leagueGames: 50,
      utcDaysToApply: 1,
      settings: { ...DEFAULT_DECAY_SETTINGS, midStreakCapKi: 0 },
    });
    expect(r.kiAppliedThisPass).toBe(100);
  });
});

describe('prize lock disabled', () => {
  it('returns null window when prizeLockEnabled is false', () => {
    const league = {
      status: 'ACTIVE' as const,
      decayEnabled: true,
      seasonEndsAt: new Date('2026-08-23T00:00:00.000Z'),
      crunchStartedAt: null,
      archivedAt: null,
      settings: { ...DEFAULT_DECAY_SETTINGS, prizeLockEnabled: false },
    };
    const now = new Date('2026-08-20T12:00:00.000Z');
    expect(resolvePrizeLockWindow(league, now)).toBeNull();
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

describe('isPrizeEligibleFromGameCount', () => {
  const seasonLeague = {
    status: 'ACTIVE' as const,
    decayEnabled: true,
    seasonEndsAt: new Date('2026-08-23T00:00:00.000Z'),
    crunchStartedAt: null,
    archivedAt: null,
    settings: { ...DEFAULT_DECAY_SETTINGS, prizeLockMinGames: 7 },
  };
  const now = new Date('2026-08-20T12:00:00.000Z');

  it('requires at least prizeLockMinGames in the crunch window', () => {
    expect(isPrizeEligibleFromGameCount(7, seasonLeague, now)).toBe(true);
    expect(isPrizeEligibleFromGameCount(6, seasonLeague, now)).toBe(false);
  });

  it('defaults to min 1 when settings omit override', () => {
    const league = {
      ...seasonLeague,
      settings: { ...DEFAULT_DECAY_SETTINGS, prizeLockMinGames: 1 },
    };
    expect(isPrizeEligibleFromGameCount(1, league, now)).toBe(true);
    expect(isPrizeEligibleFromGameCount(0, league, now)).toBe(false);
  });

  it('returns false when prize lock disabled', () => {
    const league = {
      ...seasonLeague,
      settings: { ...DEFAULT_DECAY_SETTINGS, prizeLockEnabled: false, prizeLockMinGames: 1 },
    };
    expect(isPrizeEligibleFromGameCount(99, league, now)).toBe(false);
  });
});

describe('resolvePrizeLockWindow', () => {
  // isLeagueInCrunch requires now < seasonEndsAt, so end is `now` in practice; implementation
  // still uses Math.min(now, seasonEndsAt) defensively when seasonEndsAt is set.
  it('returns crunch start through now while in crunch before season end', () => {
    const league = {
      status: 'ACTIVE' as const,
      decayEnabled: true,
      seasonEndsAt: new Date('2026-08-23T00:00:00.000Z'),
      crunchStartedAt: null,
      archivedAt: null,
    };
    const now = new Date('2026-08-20T12:00:00.000Z');
    const window = resolvePrizeLockWindow(league, now);
    expect(window?.start.toISOString()).toBe(resolveCrunchStart(league)!.toISOString());
    expect(window?.end.getTime()).toBe(now.getTime());
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
