/**
 * Per-league decay/crunch settings: merge nullable League overrides with code defaults.
 */

/** Mid-season idle days before decay starts. */
export const DEFAULT_MID_GRACE_DAYS = 10;
/** Mid-season tier-1 ki loss per day. */
export const DEFAULT_MID_TIER1_KI = 50;
/** Mid-season tier-2+ ki loss per day. */
export const DEFAULT_MID_TIER2_KI = 100;
/** Mid-season days in tier 1 after grace (tier 2 at grace + span + 1). */
export const DEFAULT_MID_TIER1_SPAN_DAYS = 9;
/** Max ki lost per idle streak mid-season; 0 = no cap. */
export const DEFAULT_MID_STREAK_CAP_KI = 1000;
/** Crunch idle days before decay. */
export const DEFAULT_CRUNCH_GRACE_DAYS = 2;
/** Crunch tier-1 ki loss per day. */
export const DEFAULT_CRUNCH_TIER1_KI = 100;
/** Crunch tier-2+ ki loss per day. */
export const DEFAULT_CRUNCH_TIER2_KI = 200;
/** Crunch days in tier 1 after grace. */
export const DEFAULT_CRUNCH_TIER1_SPAN_DAYS = 7;
/** Auto-crunch starts this many days before seasonEndsAt. */
export const DEFAULT_CRUNCH_WINDOW_DAYS = 7;
/** Whether prize-lock medals apply during crunch. */
export const DEFAULT_PRIZE_LOCK_ENABLED = true;

/** Legacy aliases used by callers that still import the old constant names. */
export const MID_GRACE_DAYS = DEFAULT_MID_GRACE_DAYS;
export const MID_TIER1_KI = DEFAULT_MID_TIER1_KI;
export const MID_TIER2_KI = DEFAULT_MID_TIER2_KI;
export const MID_STREAK_CAP_KI = DEFAULT_MID_STREAK_CAP_KI;
export const CRUNCH_GRACE_DAYS = DEFAULT_CRUNCH_GRACE_DAYS;
export const CRUNCH_TIER1_KI = DEFAULT_CRUNCH_TIER1_KI;
export const CRUNCH_TIER2_KI = DEFAULT_CRUNCH_TIER2_KI;
export const CRUNCH_WINDOW_DAYS = DEFAULT_CRUNCH_WINDOW_DAYS;
export const PRIZE_LOCK_DAYS = DEFAULT_CRUNCH_WINDOW_DAYS;

export type DecaySettingsSource = {
  decayMidGraceDays?: number | null;
  decayMidTier1Ki?: number | null;
  decayMidTier2Ki?: number | null;
  decayMidTier1SpanDays?: number | null;
  decayMidStreakCapKi?: number | null;
  decayCrunchGraceDays?: number | null;
  decayCrunchTier1Ki?: number | null;
  decayCrunchTier2Ki?: number | null;
  decayCrunchTier1SpanDays?: number | null;
  decayCrunchWindowDays?: number | null;
  decayPrizeLockEnabled?: boolean | null;
};

export type ResolvedDecaySettings = {
  midGraceDays: number;
  midTier1Ki: number;
  midTier2Ki: number;
  midTier1SpanDays: number;
  /** 0 = no mid-season streak cap. */
  midStreakCapKi: number;
  crunchGraceDays: number;
  crunchTier1Ki: number;
  crunchTier2Ki: number;
  crunchTier1SpanDays: number;
  crunchWindowDays: number;
  prizeLockEnabled: boolean;
};

/** Code defaults used when League override columns are null. */
export const DEFAULT_DECAY_SETTINGS: ResolvedDecaySettings = {
  midGraceDays: DEFAULT_MID_GRACE_DAYS,
  midTier1Ki: DEFAULT_MID_TIER1_KI,
  midTier2Ki: DEFAULT_MID_TIER2_KI,
  midTier1SpanDays: DEFAULT_MID_TIER1_SPAN_DAYS,
  midStreakCapKi: DEFAULT_MID_STREAK_CAP_KI,
  crunchGraceDays: DEFAULT_CRUNCH_GRACE_DAYS,
  crunchTier1Ki: DEFAULT_CRUNCH_TIER1_KI,
  crunchTier2Ki: DEFAULT_CRUNCH_TIER2_KI,
  crunchTier1SpanDays: DEFAULT_CRUNCH_TIER1_SPAN_DAYS,
  crunchWindowDays: DEFAULT_CRUNCH_WINDOW_DAYS,
  prizeLockEnabled: DEFAULT_PRIZE_LOCK_ENABLED,
};

function coalesceInt(value: number | null | undefined, fallback: number): number {
  return value == null ? fallback : value;
}

/** Merge nullable League columns with code defaults. */
export function resolveDecaySettings(
  league: DecaySettingsSource | null | undefined,
): ResolvedDecaySettings {
  if (!league) {
    return { ...DEFAULT_DECAY_SETTINGS };
  }

  return {
    midGraceDays: coalesceInt(league.decayMidGraceDays, DEFAULT_MID_GRACE_DAYS),
    midTier1Ki: coalesceInt(league.decayMidTier1Ki, DEFAULT_MID_TIER1_KI),
    midTier2Ki: coalesceInt(league.decayMidTier2Ki, DEFAULT_MID_TIER2_KI),
    midTier1SpanDays: coalesceInt(league.decayMidTier1SpanDays, DEFAULT_MID_TIER1_SPAN_DAYS),
    midStreakCapKi: coalesceInt(league.decayMidStreakCapKi, DEFAULT_MID_STREAK_CAP_KI),
    crunchGraceDays: coalesceInt(league.decayCrunchGraceDays, DEFAULT_CRUNCH_GRACE_DAYS),
    crunchTier1Ki: coalesceInt(league.decayCrunchTier1Ki, DEFAULT_CRUNCH_TIER1_KI),
    crunchTier2Ki: coalesceInt(league.decayCrunchTier2Ki, DEFAULT_CRUNCH_TIER2_KI),
    crunchTier1SpanDays: coalesceInt(
      league.decayCrunchTier1SpanDays,
      DEFAULT_CRUNCH_TIER1_SPAN_DAYS,
    ),
    crunchWindowDays: coalesceInt(league.decayCrunchWindowDays, DEFAULT_CRUNCH_WINDOW_DAYS),
    prizeLockEnabled:
      league.decayPrizeLockEnabled == null
        ? DEFAULT_PRIZE_LOCK_ENABLED
        : league.decayPrizeLockEnabled,
  };
}

export type DecaySettingField =
  | 'midGraceDays'
  | 'midTier1Ki'
  | 'midTier2Ki'
  | 'midTier1SpanDays'
  | 'midStreakCapKi'
  | 'crunchGraceDays'
  | 'crunchTier1Ki'
  | 'crunchTier2Ki'
  | 'crunchTier1SpanDays'
  | 'crunchWindowDays';

const DAYS_MIN = 0;
const DAYS_MAX = 90;
const WINDOW_MIN = 1;
const KI_RATE_MIN = 0;
const KI_RATE_MAX = 500;
const STREAK_CAP_MIN = 0;
const STREAK_CAP_MAX = 5000;

/** Validate a staff-provided numeric decay setting; returns the value or throws. */
export function assertDecaySettingBounds(field: DecaySettingField, value: number): number {
  if (!Number.isInteger(value)) {
    throw new Error('Value must be a whole number.');
  }

  switch (field) {
    case 'midGraceDays':
    case 'midTier1SpanDays':
    case 'crunchGraceDays':
    case 'crunchTier1SpanDays':
      if (value < DAYS_MIN || value > DAYS_MAX) {
        throw new Error(`Days must be between ${DAYS_MIN} and ${DAYS_MAX}.`);
      }
      return value;
    case 'crunchWindowDays':
      if (value < WINDOW_MIN || value > DAYS_MAX) {
        throw new Error(`Crunch window must be between ${WINDOW_MIN} and ${DAYS_MAX} days.`);
      }
      return value;
    case 'midTier1Ki':
    case 'midTier2Ki':
    case 'crunchTier1Ki':
    case 'crunchTier2Ki':
      if (value < KI_RATE_MIN || value > KI_RATE_MAX) {
        throw new Error(`Ki per day must be between ${KI_RATE_MIN} and ${KI_RATE_MAX}.`);
      }
      return value;
    case 'midStreakCapKi':
      if (value < STREAK_CAP_MIN || value > STREAK_CAP_MAX) {
        throw new Error(
          `Streak cap must be between ${STREAK_CAP_MIN} and ${STREAK_CAP_MAX} (0 = no cap).`,
        );
      }
      return value;
    default: {
      const _exhaustive: never = field;
      throw new Error(`Unknown decay setting: ${_exhaustive}`);
    }
  }
}

/** Last idle day still in tier 1 (inclusive). */
export function tier1EndIdleDay(graceDays: number, tier1SpanDays: number): number {
  return graceDays + tier1SpanDays;
}

/** Prisma select fragment for decay override columns. */
export const DECAY_SETTINGS_SELECT = {
  decayMidGraceDays: true,
  decayMidTier1Ki: true,
  decayMidTier2Ki: true,
  decayMidTier1SpanDays: true,
  decayMidStreakCapKi: true,
  decayCrunchGraceDays: true,
  decayCrunchTier1Ki: true,
  decayCrunchTier2Ki: true,
  decayCrunchTier1SpanDays: true,
  decayCrunchWindowDays: true,
  decayPrizeLockEnabled: true,
} as const;
