import { prisma } from '../../lib/prisma.js';
import {
  assertDecaySettingBounds,
  type DecaySettingField,
} from '../rating/decay-settings.js';

/** Archived-league rejection for season end / crunch staff commands. */
export const LEAGUE_DECAY_ARCHIVED_MESSAGE = 'That league is archived. Pick an active league.';

/**
 * Parse a staff-provided season end string.
 * Bare `YYYY-MM-DD` becomes UTC end of that calendar day; otherwise full ISO/datetime.
 * Rejects unparseable and non-future values.
 */
export function parseSeasonEndDate(raw: string, now = new Date()): Date {
  const trimmed = raw.trim();
  let date: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    date = new Date(`${trimmed}T23:59:59.999Z`);
  } else {
    date = new Date(trimmed);
  }
  if (Number.isNaN(date.getTime())) {
    throw new Error('Could not parse that date. Use YYYY-MM-DD or a full date/time.');
  }
  if (date.getTime() <= now.getTime()) {
    throw new Error('Season end must be in the future.');
  }
  return date;
}

/** Set or clear the league season end timestamp. */
export async function setLeagueSeasonEndsAt(
  leagueId: string,
  seasonEndsAt: Date | null,
): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { seasonEndsAt },
  });
}

export type StartLeagueCrunchResult = {
  alreadyStarted: boolean;
  crunchStartedAt: Date;
};

/**
 * Start manual crunch for a league (`crunchStartedAt = now`).
 * Idempotent when already set — returns the existing timestamp.
 */
export async function startLeagueCrunch(
  leagueId: string,
  now = new Date(),
): Promise<StartLeagueCrunchResult> {
  const existing = await prisma.league.findUnique({
    where: { id: leagueId },
    select: { crunchStartedAt: true },
  });
  if (existing?.crunchStartedAt) {
    return { alreadyStarted: true, crunchStartedAt: existing.crunchStartedAt };
  }

  const updated = await prisma.league.update({
    where: { id: leagueId },
    data: { crunchStartedAt: now },
    select: { crunchStartedAt: true },
  });

  return {
    alreadyStarted: false,
    crunchStartedAt: updated.crunchStartedAt!,
  };
}

/** Clear manual crunch (`crunchStartedAt = null`). Auto crunch from season end is unchanged. */
export async function clearLeagueCrunch(leagueId: string): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { crunchStartedAt: null },
  });
}

/** Enable or disable idle rating decay for a league. */
export async function setDecayEnabled(leagueId: string, enabled: boolean): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { decayEnabled: enabled },
  });
}

export type DecayMode = 'mid' | 'crunch';

const MODE_FIELD_MAP = {
  grace: {
    mid: 'decayMidGraceDays',
    crunch: 'decayCrunchGraceDays',
    assert: { mid: 'midGraceDays', crunch: 'crunchGraceDays' },
  },
  tier1_ki: {
    mid: 'decayMidTier1Ki',
    crunch: 'decayCrunchTier1Ki',
    assert: { mid: 'midTier1Ki', crunch: 'crunchTier1Ki' },
  },
  tier2_ki: {
    mid: 'decayMidTier2Ki',
    crunch: 'decayCrunchTier2Ki',
    assert: { mid: 'midTier2Ki', crunch: 'crunchTier2Ki' },
  },
  tier1_span: {
    mid: 'decayMidTier1SpanDays',
    crunch: 'decayCrunchTier1SpanDays',
    assert: { mid: 'midTier1SpanDays', crunch: 'crunchTier1SpanDays' },
  },
} as const;

export type DecayTunableKind = keyof typeof MODE_FIELD_MAP;

/** Set a mid/crunch mode-scoped numeric decay override. */
export async function setDecayModeSetting(
  leagueId: string,
  kind: DecayTunableKind,
  mode: DecayMode,
  value: number,
): Promise<void> {
  const entry = MODE_FIELD_MAP[kind];
  const assertField = entry.assert[mode] as DecaySettingField;
  const column = entry[mode];
  const safe = assertDecaySettingBounds(assertField, value);
  await prisma.league.update({
    where: { id: leagueId },
    data: { [column]: safe },
  });
}

/** Clear a mid/crunch mode-scoped numeric decay override (back to code default). */
export async function clearDecayModeSetting(
  leagueId: string,
  kind: DecayTunableKind,
  mode: DecayMode,
): Promise<void> {
  const column = MODE_FIELD_MAP[kind][mode];
  await prisma.league.update({
    where: { id: leagueId },
    data: { [column]: null },
  });
}

/** Set mid-season streak cap (0 = no cap). */
export async function setDecayStreakCap(leagueId: string, ki: number): Promise<void> {
  const safe = assertDecaySettingBounds('midStreakCapKi', ki);
  await prisma.league.update({
    where: { id: leagueId },
    data: { decayMidStreakCapKi: safe },
  });
}

/** Clear mid-season streak cap override. */
export async function clearDecayStreakCap(leagueId: string): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { decayMidStreakCapKi: null },
  });
}

/** Set auto-crunch window days before season end. */
export async function setDecayCrunchWindow(leagueId: string, days: number): Promise<void> {
  const safe = assertDecaySettingBounds('crunchWindowDays', days);
  await prisma.league.update({
    where: { id: leagueId },
    data: { decayCrunchWindowDays: safe },
  });
}

/** Clear auto-crunch window override. */
export async function clearDecayCrunchWindow(leagueId: string): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { decayCrunchWindowDays: null },
  });
}

/** Enable or disable prize-lock medals during crunch. */
export async function setDecayPrizeLock(leagueId: string, enabled: boolean): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { decayPrizeLockEnabled: enabled },
  });
}

/** Clear prize-lock override (back to default on). */
export async function clearDecayPrizeLock(leagueId: string): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { decayPrizeLockEnabled: null },
  });
}
