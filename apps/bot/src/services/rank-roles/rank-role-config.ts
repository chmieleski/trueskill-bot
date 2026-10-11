import { Prisma } from '@dbz/db';
import { prisma } from '../../lib/prisma.js';
import {
  type ReplacedRoleHolder,
  toReplacedHolder,
} from '../hero-champion-roles/hero-champion-config.js';
import { MatchServiceError } from '../match/match-service.js';

export const RANK_ROLE_DUPLICATE =
  'That Discord role is already mapped to another leaderboard rank in this league.';

export const RANK_ROLE_USED_BY_HERO =
  'That Discord role is already mapped as a hero champion role in this league.';

/** Enable or disable leaderboard rank role sync for a league. */
export async function setLeagueRankRolesEnabled(leagueId: string, enabled: boolean): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { rankRolesEnabled: enabled, ...(enabled ? { rankRolesDirty: true } : {}) },
  });
}

/**
 * Upsert a staff-mapped Discord role for one leaderboard position (1–3).
 * Returns the replaced holder so the caller can strip the old Discord role.
 */
export async function setLeagueRankRole(
  leagueId: string,
  rank: number,
  discordRoleId: string,
): Promise<ReplacedRoleHolder | null> {
  const heroUse = await prisma.leagueHeroChampionRole.findUnique({
    where: { leagueId_discordRoleId: { leagueId, discordRoleId } },
  });
  if (heroUse) {
    throw new MatchServiceError(RANK_ROLE_USED_BY_HERO);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const previous = await tx.leagueRankRole.findUnique({
        where: { leagueId_rank: { leagueId, rank } },
        select: { discordRoleId: true, holderDiscordId: true },
      });
      await tx.leagueRankRole.upsert({
        where: { leagueId_rank: { leagueId, rank } },
        create: { leagueId, rank, discordRoleId, holderDiscordId: null },
        // Remap clears the holder so the next sync assigns cleanly.
        update: { discordRoleId, holderDiscordId: null },
      });
      await tx.league.update({ where: { id: leagueId }, data: { rankRolesDirty: true } });
      return toReplacedHolder(previous);
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new MatchServiceError(RANK_ROLE_DUPLICATE);
    }
    throw error;
  }
}

/** List rank role mappings for config view. */
export async function listLeagueRankRoles(
  leagueId: string,
): Promise<{ rank: number; discordRoleId: string; holderDiscordId: string | null }[]> {
  return prisma.leagueRankRole.findMany({
    where: { leagueId },
    select: { rank: true, discordRoleId: true, holderDiscordId: true },
    orderBy: { rank: 'asc' },
  });
}
