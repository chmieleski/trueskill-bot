import { displayConservatismZ, KI_SCALE } from './rating-math.js';

export const MID_GRACE_DAYS = 10;
export const MID_TIER1_KI = 50;
export const MID_TIER2_KI = 100;
export const MID_STREAK_CAP_KI = 1000;
export const CRUNCH_GRACE_DAYS = 2;
export const CRUNCH_TIER1_KI = 100;
export const CRUNCH_TIER2_KI = 200;
export const CRUNCH_WINDOW_DAYS = 7;
export const PRIZE_LOCK_DAYS = 7;

const MS_PER_UTC_DAY = 86_400_000;

export type DecayLeagueContext = {
  status: string;
  decayEnabled: boolean;
  seasonEndsAt: Date | null;
  crunchStartedAt: Date | null;
  archivedAt?: Date | null;
};

export type ComputeDecayDeltaInput = {
  idleDays: number;
  inCrunch: boolean;
  streakKiApplied: number;
  mu: number;
  sigma: number;
  leagueGames: number;
  /** Whole UTC days to apply (usually 1; 0 for idempotent same-day). */
  utcDaysToApply: number;
};

export type ComputeDecayDeltaResult = {
  muDelta: number;
  streakKiApplied: number;
  kiAppliedThisPass: number;
};

/** Whole UTC day index since Unix epoch. */
export function utcDayIndex(date: Date): number {
  return Math.floor(date.getTime() / MS_PER_UTC_DAY);
}

/** Whole UTC days elapsed from activity to now. */
export function idleDaysSince(activityAt: Date, now: Date): number {
  return utcDayIndex(now) - utcDayIndex(activityAt);
}

/** Daily ki loss for a given idle streak day count and crunch mode. */
export function dailyKiLoss(idleDays: number, inCrunch: boolean): number {
  if (inCrunch) {
    if (idleDays <= CRUNCH_GRACE_DAYS) return 0;
    if (idleDays <= 9) return CRUNCH_TIER1_KI;
    return CRUNCH_TIER2_KI;
  }
  if (idleDays <= MID_GRACE_DAYS) return 0;
  if (idleDays <= 19) return MID_TIER1_KI;
  return MID_TIER2_KI;
}

/** Minimum μ before public ki hits the ~1000 floor for this player. */
export function muFloor(sigma: number, leagueGames: number): number {
  return displayConservatismZ(leagueGames) * sigma;
}

/** Convert ki loss to μ erosion. */
export function kiLossToMuDelta(kiLoss: number): number {
  return -kiLoss / KI_SCALE;
}

/**
 * Pure decay delta for one or more pending UTC days.
 * Applies mid-season streak cap, μ floor, and per-day tier progression.
 */
export function computeDecayDelta(input: ComputeDecayDeltaInput): ComputeDecayDeltaResult {
  const {
    idleDays: initialIdleDays,
    inCrunch,
    streakKiApplied: initialStreakKi,
    mu: initialMu,
    sigma,
    leagueGames,
    utcDaysToApply,
  } = input;

  if (utcDaysToApply <= 0) {
    return {
      muDelta: 0,
      streakKiApplied: initialStreakKi,
      kiAppliedThisPass: 0,
    };
  }

  const floor = muFloor(sigma, leagueGames);
  let mu = initialMu;
  let streakKiApplied = initialStreakKi;
  let kiAppliedThisPass = 0;
  let idleDays = initialIdleDays;

  for (let day = 0; day < utcDaysToApply; day += 1) {
    let desiredKi = dailyKiLoss(idleDays, inCrunch);

    if (!inCrunch) {
      const remainingStreakRoom = MID_STREAK_CAP_KI - streakKiApplied;
      desiredKi = Math.min(desiredKi, Math.max(0, remainingStreakRoom));
    }

    if (desiredKi <= 0) {
      idleDays += 1;
      continue;
    }

    const desiredMuDelta = kiLossToMuDelta(desiredKi);
    const minMu = floor;
    const maxAllowedMuDelta = mu - minMu;
    const actualMuDelta = Math.max(desiredMuDelta, -maxAllowedMuDelta);
    const actualKi = Math.round(-actualMuDelta * KI_SCALE);

    if (actualKi <= 0) {
      idleDays += 1;
      continue;
    }

    mu += actualMuDelta;
    streakKiApplied += actualKi;
    kiAppliedThisPass += actualKi;
    idleDays += 1;
  }

  return {
    muDelta: mu - initialMu,
    streakKiApplied,
    kiAppliedThisPass,
  };
}

/** Earliest UTC instant when crunch rules apply for this league. */
export function resolveCrunchStart(league: DecayLeagueContext): Date | null {
  const candidates: Date[] = [];

  if (league.seasonEndsAt) {
    candidates.push(
      new Date(league.seasonEndsAt.getTime() - CRUNCH_WINDOW_DAYS * MS_PER_UTC_DAY),
    );
  }

  if (league.crunchStartedAt) {
    candidates.push(league.crunchStartedAt);
  }

  if (candidates.length === 0) {
    return null;
  }

  return new Date(Math.min(...candidates.map((d) => d.getTime())));
}

/** True when crunch decay tiers replace mid-season tiers. */
export function isLeagueInCrunch(league: DecayLeagueContext, now: Date): boolean {
  if (league.status !== 'ACTIVE' || !league.decayEnabled) {
    return false;
  }

  if (league.crunchStartedAt && now >= league.crunchStartedAt) {
    if (!league.seasonEndsAt || now < league.seasonEndsAt) {
      return true;
    }
  }

  if (league.seasonEndsAt) {
    const start = new Date(
      league.seasonEndsAt.getTime() - CRUNCH_WINDOW_DAYS * MS_PER_UTC_DAY,
    );
    return now >= start && now < league.seasonEndsAt;
  }

  return false;
}

/** Prize medal eligibility during crunch (leaderboard only). */
export function isPrizeEligible(
  activityAt: Date,
  league: DecayLeagueContext,
  now: Date,
): boolean {
  if (!isLeagueInCrunch(league, now)) {
    return false;
  }

  if (league.seasonEndsAt) {
    const cutoff = new Date(
      league.seasonEndsAt.getTime() - PRIZE_LOCK_DAYS * MS_PER_UTC_DAY,
    );
    return activityAt >= cutoff;
  }

  const crunchStart = resolveCrunchStart(league);
  if (!crunchStart) {
    return false;
  }

  return activityAt >= crunchStart;
}
