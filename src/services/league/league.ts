import type { League } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';

export type { League };

/** User-facing message when a command targets an archived league for writes. */
export const LEAGUE_ARCHIVED_MESSAGE =
  'That league is archived. Start a new season or pick an active league.';

/**
 * Temporary helper for call sites that do not yet have resolveLeagueContext (Task 4/7).
 * Returns the id of the first (chronologically) UDBR league for the guild, or null if none.
 */
export async function getDefaultUdbrLeagueId(guildId: string): Promise<string | null> {
  const league = await prisma.league.findFirst({
    where: { guildId, gameId: WARCRAFT3_UDBR_GAME_ID },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  return league?.id ?? null;
}

/** Create a new league for a guild. */
export async function createLeague(input: {
  guildId: string;
  gameId: string;
  name: string;
}): Promise<League> {
  const profile = getGameProfile(input.gameId);
  return prisma.league.create({
    data: {
      guildId: input.guildId,
      gameId: input.gameId,
      name: input.name,
      showSideWinLoss: profile.sideWinLossDefault,
    },
  });
}

/** List all leagues for a guild, oldest first. */
export async function listLeaguesForGuild(guildId: string): Promise<League[]> {
  return prisma.league.findMany({
    where: { guildId },
    orderBy: { createdAt: 'asc' },
  });
}

/** List active leagues for a guild, oldest first. */
export async function listActiveLeaguesForGuild(guildId: string): Promise<League[]> {
  return prisma.league.findMany({
    where: { guildId, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  });
}

/** List archived leagues for a guild, most recently archived first. */
export async function listArchivedLeaguesForGuild(guildId: string): Promise<League[]> {
  return prisma.league.findMany({
    where: { guildId, status: 'ARCHIVED' },
    orderBy: { archivedAt: 'desc' },
  });
}

/** Whether match/rating writes are allowed for this league. */
export function isLeagueWritable(league: Pick<League, 'status'>): boolean {
  return league.status === 'ACTIVE';
}

/** Fetch a single league by its id. Returns null when not found. */
export async function getLeagueById(id: string): Promise<League | null> {
  return prisma.league.findUnique({ where: { id } });
}
