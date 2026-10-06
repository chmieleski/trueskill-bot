import { Prisma } from '@dbz/db';
import { prisma } from '../../lib/prisma.js';
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

/** Upsert a staff-mapped Discord role for one leaderboard position (1–3). */
export async function setLeagueRankRole(
  leagueId: string,
  rank: number,
  discordRoleId: string,
): Promise<void> {
  const heroUse = await prisma.leagueHeroChampionRole.findUnique({
    where: { leagueId_discordRoleId: { leagueId, discordRoleId } },
  });
  if (heroUse) {
    throw new MatchServiceError(RANK_ROLE_USED_BY_HERO);
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.leagueRankRole.upsert({
        where: { leagueId_rank: { leagueId, rank } },
        create: { leagueId, rank, discordRoleId, holderDiscordId: null },
        // Remap clears the holder so the next sync assigns cleanly.
        update: { discordRoleId, holderDiscordId: null },
      });
      await tx.league.update({ where: { id: leagueId }, data: { rankRolesDirty: true } });
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
