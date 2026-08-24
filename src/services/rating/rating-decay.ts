import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { gamesByPlayerFromStats, loadMatchDisplayStatsByPlayer } from './rank-reset-display.js';
import { displayConservatismZ, isCalibrating, KI_SCALE } from './rating-math.js';
import {
  DECAY_SETTINGS_SELECT,
  DEFAULT_DECAY_SETTINGS,
  resolveDecaySettings,
  tier1EndIdleDay,
  type DecaySettingsSource,
  type ResolvedDecaySettings,
} from './decay-settings.js';

export {
  CRUNCH_GRACE_DAYS,
  CRUNCH_TIER1_KI,
  CRUNCH_TIER2_KI,
  CRUNCH_WINDOW_DAYS,
  DEFAULT_DECAY_SETTINGS,
  DECAY_SETTINGS_SELECT,
  MID_GRACE_DAYS,
  MID_STREAK_CAP_KI,
  MID_TIER1_KI,
  MID_TIER2_KI,
  PRIZE_LOCK_DAYS,
  resolveDecaySettings,
  type DecaySettingsSource,
  type ResolvedDecaySettings,
} from './decay-settings.js';

type Db = Prisma.TransactionClient | typeof prisma;

const MS_PER_UTC_DAY = 86_400_000;

export type DecayLeagueContext = {
  status: string;
  decayEnabled: boolean;
  seasonEndsAt: Date | null;
  crunchStartedAt: Date | null;
  archivedAt?: Date | null;
  /** When omitted, code defaults apply (backward-compatible for tests/callers). */
  settings?: ResolvedDecaySettings;
};

/** Effective decay settings for a league context. */
export function leagueDecaySettings(league: DecayLeagueContext): ResolvedDecaySettings {
  return league.settings ?? DEFAULT_DECAY_SETTINGS;
}

/** Build a DecayLeagueContext from a League row (or partial) + resolved settings. */
export function toDecayLeagueContext(
  league: {
    status: string;
    decayEnabled: boolean;
    seasonEndsAt: Date | null;
    crunchStartedAt: Date | null;
    archivedAt?: Date | null;
  } & DecaySettingsSource,
): DecayLeagueContext {
  return {
    status: league.status,
    decayEnabled: league.decayEnabled,
    seasonEndsAt: league.seasonEndsAt,
    crunchStartedAt: league.crunchStartedAt,
    archivedAt: league.archivedAt,
    settings: resolveDecaySettings(league),
  };
}

export type ComputeDecayDeltaInput = {
  idleDays: number;
  inCrunch: boolean;
  streakKiApplied: number;
  mu: number;
  sigma: number;
  leagueGames: number;
  /** Whole UTC days to apply (usually 1; 0 for idempotent same-day). */
  utcDaysToApply: number;
  settings?: ResolvedDecaySettings;
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
export function dailyKiLoss(
  idleDays: number,
  inCrunch: boolean,
  settings: ResolvedDecaySettings = DEFAULT_DECAY_SETTINGS,
): number {
  if (inCrunch) {
    if (idleDays <= settings.crunchGraceDays) return 0;
    if (idleDays <= tier1EndIdleDay(settings.crunchGraceDays, settings.crunchTier1SpanDays)) {
      return settings.crunchTier1Ki;
    }
    return settings.crunchTier2Ki;
  }
  if (idleDays <= settings.midGraceDays) return 0;
  if (idleDays <= tier1EndIdleDay(settings.midGraceDays, settings.midTier1SpanDays)) {
    return settings.midTier1Ki;
  }
  return settings.midTier2Ki;
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
    settings = DEFAULT_DECAY_SETTINGS,
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
    let desiredKi = dailyKiLoss(idleDays, inCrunch, settings);

    if (!inCrunch && settings.midStreakCapKi > 0) {
      const remainingStreakRoom = settings.midStreakCapKi - streakKiApplied;
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
  const windowDays = leagueDecaySettings(league).crunchWindowDays;

  if (league.seasonEndsAt) {
    candidates.push(new Date(league.seasonEndsAt.getTime() - windowDays * MS_PER_UTC_DAY));
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
      league.seasonEndsAt.getTime() - leagueDecaySettings(league).crunchWindowDays * MS_PER_UTC_DAY,
    );
    return now >= start && now < league.seasonEndsAt;
  }

  return false;
}

/** Build `/rank` idle-decay footer from resolved settings. */
export function formatIdleDecayFooter(settings: ResolvedDecaySettings): string {
  const startDay = settings.midGraceDays + 1;
  const tier2Start = tier1EndIdleDay(settings.midGraceDays, settings.midTier1SpanDays) + 1;
  return `Inactive ${startDay}+ days: league ki decays −${settings.midTier1Ki}/day (−${settings.midTier2Ki}/day after ${tier2Start} days) until you finish a game.`;
}

/** Build `/rank` crunch-decay footer from resolved settings. */
export function formatCrunchDecayFooter(settings: ResolvedDecaySettings): string {
  const tier2Start = tier1EndIdleDay(settings.crunchGraceDays, settings.crunchTier1SpanDays) + 1;
  return `Crunch week: −${settings.crunchTier1Ki} ki/day after ${settings.crunchGraceDays} idle days (−${settings.crunchTier2Ki}/day after ${tier2Start}).`;
}

/** Default footers (code defaults) — kept for tests and static imports. */
export const RANK_CRUNCH_DECAY_FOOTER = formatCrunchDecayFooter(DEFAULT_DECAY_SETTINGS);
export const RANK_IDLE_DECAY_FOOTER = formatIdleDecayFooter(DEFAULT_DECAY_SETTINGS);

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

  const settings = leagueDecaySettings(input.league);
  const inCrunch = isLeagueInCrunch(input.league, now);
  if (inCrunch) {
    return formatCrunchDecayFooter(settings);
  }

  const idleDays = idleDaysSince(input.lastQualifyingActivityAt, now);
  if (idleDays > settings.midGraceDays) {
    return formatIdleDecayFooter(settings);
  }

  return null;
}

/** UTC day range for prize-lock checks while crunch is active (inclusive). */
export function resolvePrizeLockWindowDays(
  league: DecayLeagueContext,
  now: Date,
): { startDay: number; endDay: number } | null {
  const window = resolvePrizeLockWindow(league, now);
  if (!window) {
    return null;
  }

  return {
    startDay: utcDayIndex(window.start),
    endDay: utcDayIndex(window.end),
  };
}

/** Date range for prize-lock checks while crunch is active (inclusive). */
export function resolvePrizeLockWindow(
  league: DecayLeagueContext,
  now: Date,
): { start: Date; end: Date } | null {
  if (!leagueDecaySettings(league).prizeLockEnabled) {
    return null;
  }
  if (!isLeagueInCrunch(league, now)) {
    return null;
  }

  const crunchStart = resolveCrunchStart(league);
  if (!crunchStart) {
    return null;
  }

  const end =
    league.seasonEndsAt != null
      ? new Date(Math.min(now.getTime(), league.seasonEndsAt.getTime()))
      : now;

  return { start: crunchStart, end };
}

/** Prize medal eligibility during crunch from qualifying game count (leaderboard only). */
export function isPrizeEligibleFromGameCount(
  gameCount: number,
  league: DecayLeagueContext,
  now: Date,
): boolean {
  const window = resolvePrizeLockWindow(league, now);
  if (!window) {
    return false;
  }
  return gameCount >= leagueDecaySettings(league).prizeLockMinGames;
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

/** Prize medal eligibility during crunch (leaderboard only). @deprecated Use isPrizeEligibleFromGameCount. */
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
 * Completed non-quit match counts per player in the prize-lock window.
 */
export async function loadQualifyingGameCountsByPlayer(
  leagueId: string,
  playerIds: string[],
  start: Date,
  end: Date,
  db: Db = prisma,
): Promise<Map<string, number>> {
  const uniquePlayerIds = [...new Set(playerIds)];
  if (uniquePlayerIds.length === 0) {
    return new Map();
  }

  const rows = await db.matchPlayer.findMany({
    where: {
      playerId: { in: uniquePlayerIds },
      isQuitter: false,
      match: {
        leagueId,
        status: 'COMPLETED',
        completedAt: {
          gte: start,
          lte: end,
        },
      },
    },
    select: {
      playerId: true,
    },
  });

  const countsByPlayer = new Map<string, number>();
  for (const row of rows) {
    countsByPlayer.set(row.playerId, (countsByPlayer.get(row.playerId) ?? 0) + 1);
  }

  return countsByPlayer;
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
        ...DECAY_SETTINGS_SELECT,
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

  const leagueCtx = toDecayLeagueContext(league);
  const settings = leagueDecaySettings(leagueCtx);
  const idleDays = idleDaysSince(activityAt, now) - utcDaysToApply + 1;
  const inCrunch = isLeagueInCrunch(leagueCtx, now);

  const delta = computeDecayDelta({
    idleDays,
    inCrunch,
    streakKiApplied: rating.idleDecayKiApplied,
    mu: rating.mu,
    sigma: rating.sigma,
    leagueGames,
    utcDaysToApply,
    settings,
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
