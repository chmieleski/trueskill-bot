import { prisma } from '../../lib/prisma.js';

/** Archived-league rejection for season end / crunch staff commands. */
export const LEAGUE_DECAY_ARCHIVED_MESSAGE =
  'That league is archived. Pick an active league.';

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
