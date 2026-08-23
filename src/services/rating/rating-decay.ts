import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { gamesByPlayerFromStats, loadMatchDisplayStatsByPlayer } from './rank-reset-display.js';
import { displayConservatismZ, isCalibrating, KI_SCALE } from './rating-math.js';

type Db = Prisma.TransactionClient | typeof prisma;

export const MID_GRACE_DAYS = 10;
export const MID_TIER1_KI = 50;
export const MID_TIER2_KI = 100;
export const MID_STREAK_CAP_KI = 1000;
export const CRUNCH_GRACE_DAYS = 2;
export const CRUNCH_TIER1_KI = 100;
export const CRUNCH_TIER2_KI = 200;
export const CRUNCH_WINDOW_DAYS = 7;
export const PRIZE_LOCK_DAYS = 7;

export const RANK_CRUNCH_DECAY_FOOTER =
  'Crunch week: −100 ki/day after 2 idle days (−200/day after 10).';
export const RANK_IDLE_DECAY_FOOTER =
  'Inactive 11+ days: league ki decays −50/day (−100/day after 20 days) until you finish a game.';

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

/**
 * Pending whole UTC days of decay since last apply (or activity when never applied).
 * Zero when last apply shares the same UTC day as `now` (idempotent same-day guard).
 */
export function pendingUtcDaysToApply(
  lastDecayAppliedAt: Date | null,
  lastQualifyingActivityAt: Date,
  now: Date,
): number {
  const from = lastDecayAppliedAt ?? lastQualifyingActivityAt;
  return Math.max(0, utcDayIndex(now) - utcDayIndex(from));
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
    candidates.push(new Date(league.seasonEndsAt.getTime() - CRUNCH_WINDOW_DAYS * MS_PER_UTC_DAY));
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
    const start = new Date(league.seasonEndsAt.getTime() - CRUNCH_WINDOW_DAYS * MS_PER_UTC_DAY);
    return now >= start && now < league.seasonEndsAt;
  }

  return false;
}

/** Player-facing `/rank` footer when decay applies; null when hidden. */
export function resolveRankDecayFooter(input: {
  decayEnabled: boolean;
  leagueGames: number;
  isNewPlayer: boolean;
  lastQualifyingActivityAt: Date | null;
  league: DecayLeagueContext;
  now?: Date;
}): string | null {
  const now = input.now ?? new Date();
  if (
    input.league.status !== 'ACTIVE' ||
    !input.decayEnabled ||
    input.isNewPlayer ||
    input.lastQualifyingActivityAt == null ||
    isCalibrating(input.leagueGames)
  ) {
    return null;
  }

  const inCrunch = isLeagueInCrunch(input.league, now);
  if (inCrunch) {
    return RANK_CRUNCH_DECAY_FOOTER;
  }

  const idleDays = idleDaysSince(input.lastQualifyingActivityAt, now);
  if (idleDays > MID_GRACE_DAYS) {
    return RANK_IDLE_DECAY_FOOTER;
  }

  return null;
}

/** UTC day range for prize-lock checks while crunch is active (inclusive). */
export function resolvePrizeLockWindowDays(
  league: DecayLeagueContext,
  now: Date,
): { startDay: number; endDay: number } | null {
  if (!isLeagueInCrunch(league, now)) {
    return null;
  }

  const crunchStart = resolveCrunchStart(league);
  if (!crunchStart) {
    return null;
  }

  return {
    startDay: utcDayIndex(crunchStart),
    endDay: utcDayIndex(now),
  };
}

/** True when the player has qualifying activity on every UTC day in the window. */
export function hasQualifyingActivityEveryUtcDay(
  activeUtcDays: ReadonlySet<number>,
  startDay: number,
  endDay: number,
): boolean {
  for (let day = startDay; day <= endDay; day += 1) {
    if (!activeUtcDays.has(day)) {
      return false;
    }
  }
  return true;
}

/** Prize medal eligibility during crunch (leaderboard only). */
export function isPrizeEligibleFromActivityDays(
  activeUtcDays: ReadonlySet<number>,
  league: DecayLeagueContext,
  now: Date,
): boolean {
  const window = resolvePrizeLockWindowDays(league, now);
  if (!window) {
    return false;
  }

  return hasQualifyingActivityEveryUtcDay(activeUtcDays, window.startDay, window.endDay);
}

/**
 * Distinct UTC days with a completed non-quit match per player in the prize-lock window.
 */
export async function loadQualifyingActivityUtcDaysByPlayer(
  leagueId: string,
  playerIds: string[],
  windowStartDay: number,
  windowEndDay: number,
  db: Db = prisma,
): Promise<Map<string, Set<number>>> {
  const uniquePlayerIds = [...new Set(playerIds)];
  if (uniquePlayerIds.length === 0) {
    return new Map();
  }

  const windowStart = new Date(windowStartDay * MS_PER_UTC_DAY);
  const windowEndExclusive = new Date((windowEndDay + 1) * MS_PER_UTC_DAY);

  const rows = await db.matchPlayer.findMany({
    where: {
      playerId: { in: uniquePlayerIds },
      isQuitter: false,
      match: {
        leagueId,
        status: 'COMPLETED',
        completedAt: {
          gte: windowStart,
          lt: windowEndExclusive,
        },
      },
    },
    select: {
      playerId: true,
      match: { select: { completedAt: true } },
    },
  });

  const activityDaysByPlayer = new Map<string, Set<number>>();
  for (const row of rows) {
    const completedAt = row.match.completedAt;
    if (completedAt == null) {
      continue;
    }

    const day = utcDayIndex(completedAt);
    if (day < windowStartDay || day > windowEndDay) {
      continue;
    }

    let days = activityDaysByPlayer.get(row.playerId);
    if (!days) {
      days = new Set<number>();
      activityDaysByPlayer.set(row.playerId, days);
    }
    days.add(day);
  }

  return activityDaysByPlayer;
}

export type ApplyPendingDecayResult = {
  applied: boolean;
  mu?: number;
};

/**
 * Catch-up idle decay for one player. No-op when exempt, already applied today, or no pending days.
 * When pending UTC days exist, always advances `lastDecayAppliedAt` (even if grace yields Δμ = 0).
 */
export async function applyPendingDecay(
  leagueId: string,
  playerId: string,
  db: Db = prisma,
  now: Date = new Date(),
): Promise<ApplyPendingDecayResult> {
  const [league, rating] = await Promise.all([
    db.league.findUnique({
      where: { id: leagueId },
      select: {
        status: true,
        decayEnabled: true,
        seasonEndsAt: true,
        crunchStartedAt: true,
        archivedAt: true,
      },
    }),
    db.playerRating.findUnique({
      where: { leagueId_playerId: { leagueId, playerId } },
      select: {
        mu: true,
        sigma: true,
        isNewPlayer: true,
        lastQualifyingActivityAt: true,
        idleDecayKiApplied: true,
        lastDecayAppliedAt: true,
      },
    }),
  ]);

  if (!league || league.status !== 'ACTIVE' || !league.decayEnabled) {
    return { applied: false };
  }

  if (!rating || rating.isNewPlayer || rating.lastQualifyingActivityAt == null) {
    return { applied: false };
  }

  const displayStats = await loadMatchDisplayStatsByPlayer(leagueId, [playerId], db);
  const leagueGames = gamesByPlayerFromStats(displayStats).get(playerId) ?? 0;
  if (isCalibrating(leagueGames)) {
    return { applied: false };
  }

  const activityAt = rating.lastQualifyingActivityAt;
  const utcDaysToApply = pendingUtcDaysToApply(rating.lastDecayAppliedAt, activityAt, now);
  if (utcDaysToApply <= 0) {
    return { applied: false };
  }

  const idleDays = idleDaysSince(activityAt, now) - utcDaysToApply + 1;
  const inCrunch = isLeagueInCrunch(
    {
      status: league.status,
      decayEnabled: league.decayEnabled,
      seasonEndsAt: league.seasonEndsAt,
      crunchStartedAt: league.crunchStartedAt,
      archivedAt: league.archivedAt,
    },
    now,
  );

  const delta = computeDecayDelta({
    idleDays,
    inCrunch,
    streakKiApplied: rating.idleDecayKiApplied,
    mu: rating.mu,
    sigma: rating.sigma,
    leagueGames,
    utcDaysToApply,
  });

  const nextMu = rating.mu + delta.muDelta;
  await db.playerRating.update({
    where: { leagueId_playerId: { leagueId, playerId } },
    data: {
      mu: nextMu,
      idleDecayKiApplied: delta.streakKiApplied,
      lastDecayAppliedAt: now,
    },
  });

  return { applied: true, mu: nextMu };
}

/** Catch-up idle decay for many roster players in one league (read-path helper). */
export async function applyPendingDecayForPlayers(
  leagueId: string,
  playerIds: string[],
  db: Db = prisma,
  now: Date = new Date(),
): Promise<void> {
  const unique = [...new Set(playerIds)];
  for (const playerId of unique) {
    await applyPendingDecay(leagueId, playerId, db, now);
  }
}

/**
 * Daily batch: ACTIVE leagues with decay enabled; ratings with non-null qualifying activity.
 */
export async function runDecayBatchForAllLeagues(
  now: Date = new Date(),
): Promise<{ leagues: number; playersUpdated: number }> {
  const leagues = await prisma.league.findMany({
    where: { status: 'ACTIVE', decayEnabled: true },
    select: { id: true },
  });

  let playersUpdated = 0;

  for (const league of leagues) {
    const ratings = await prisma.playerRating.findMany({
      where: {
        leagueId: league.id,
        lastQualifyingActivityAt: { not: null },
        isNewPlayer: false,
      },
      select: { playerId: true },
    });

    for (const row of ratings) {
      const result = await applyPendingDecay(league.id, row.playerId, prisma, now);
      if (result.applied) {
        playersUpdated += 1;
      }
    }
  }

  return { leagues: leagues.length, playersUpdated };
}
