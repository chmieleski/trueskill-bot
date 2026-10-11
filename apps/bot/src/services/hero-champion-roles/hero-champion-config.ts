import { Prisma } from '@dbz/db';
import { getGameProfile } from '../../domain/game-profile.js';
import { prisma } from '../../lib/prisma.js';
import { MatchServiceError } from '../match/match-service.js';

export const HERO_CHAMPION_ROLES_UNSUPPORTED =
  'Hero champion roles are not available for this league’s game.';

export const HERO_CHAMPION_ROLE_DUPLICATE =
  'That Discord role is already mapped to another hero in this league.';

export const HERO_CHAMPION_UNKNOWN_HERO = 'Unknown hero.';

/** Discord role + member that a remap displaced. Shared with rank role config. */
export type ReplacedRoleHolder = { discordRoleId: string; holderDiscordId: string };

/** Keep only a mapping that actually had a holder. */
export function toReplacedHolder(
  previous: { discordRoleId: string; holderDiscordId: string | null } | null,
): ReplacedRoleHolder | null {
  return previous?.holderDiscordId
    ? { discordRoleId: previous.discordRoleId, holderDiscordId: previous.holderDiscordId }
    : null;
}

export const HERO_CHAMPION_ROLE_USED_BY_RANK =
  'That Discord role is already mapped as a leaderboard rank role in this league.';

/** Ensure the league’s game supports hero champion roles. */
export async function assertHeroChampionRolesSupported(leagueId: string): Promise<void> {
  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    select: { gameId: true },
  });
  if (!league) {
    throw new MatchServiceError('League not found.');
  }
  const profile = getGameProfile(league.gameId);
  if (!profile.heroChampionRoles) {
    throw new MatchServiceError(HERO_CHAMPION_ROLES_UNSUPPORTED);
  }
}

/** Enable or disable hero champion role sync for a league. */
export async function setLeagueHeroChampionRolesEnabled(
  leagueId: string,
  enabled: boolean,
): Promise<void> {
  await assertHeroChampionRolesSupported(leagueId);
  await prisma.league.update({
    where: { id: leagueId },
    data: {
      heroChampionRolesEnabled: enabled,
      ...(enabled ? { heroChampionRolesDirty: true } : {}),
    },
  });
}

/**
 * Upsert a staff-mapped Discord role for a hero in this league.
 * Returns the replaced holder so the caller can strip the old Discord role
 * (the remap forgets the holder, so sync alone would leave a duplicate).
 */
export async function setLeagueHeroChampionRole(
  leagueId: string,
  heroId: number,
  discordRoleId: string,
): Promise<ReplacedRoleHolder | null> {
  await assertHeroChampionRolesSupported(leagueId);

  const hero = await prisma.hero.findUnique({ where: { id: heroId } });
  if (!hero) {
    throw new MatchServiceError(HERO_CHAMPION_UNKNOWN_HERO);
  }

  const rankUse = await prisma.leagueRankRole.findUnique({
    where: { leagueId_discordRoleId: { leagueId, discordRoleId } },
  });
  if (rankUse) {
    throw new MatchServiceError(HERO_CHAMPION_ROLE_USED_BY_RANK);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const previous = await tx.leagueHeroChampionRole.findUnique({
        where: { leagueId_heroId: { leagueId, heroId } },
        select: { discordRoleId: true, holderDiscordId: true },
      });
      await tx.leagueHeroChampionRole.upsert({
        where: { leagueId_heroId: { leagueId, heroId } },
        create: {
          leagueId,
          heroId,
          discordRoleId,
          holderDiscordId: null,
        },
        update: {
          discordRoleId,
          // Remap clears sticky holder so the next sync assigns cleanly.
          holderDiscordId: null,
        },
      });
      await tx.league.update({
        where: { id: leagueId },
        data: { heroChampionRolesDirty: true },
      });
      return toReplacedHolder(previous);
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new MatchServiceError(HERO_CHAMPION_ROLE_DUPLICATE);
    }
    throw error;
  }
}

/** List champion role mappings for config view. */
export async function listLeagueHeroChampionRoles(leagueId: string): Promise<
  {
    heroId: number;
    heroName: string;
    discordRoleId: string;
    holderDiscordId: string | null;
  }[]
> {
  const rows = await prisma.leagueHeroChampionRole.findMany({
    where: { leagueId },
    include: { hero: { select: { name: true } } },
    orderBy: { heroId: 'asc' },
  });
  return rows.map((row) => ({
    heroId: row.heroId,
    heroName: row.hero.name,
    discordRoleId: row.discordRoleId,
    holderDiscordId: row.holderDiscordId,
  }));
}
