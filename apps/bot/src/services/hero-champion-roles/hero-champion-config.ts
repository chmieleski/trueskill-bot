import { Prisma } from '@dbz/db';
import { getGameProfile } from '../../domain/game-profile.js';
import { prisma } from '../../lib/prisma.js';
import { MatchServiceError } from '../match/match-service.js';

export const HERO_CHAMPION_ROLES_UNSUPPORTED =
  'Hero champion roles are not available for this league’s game.';

export const HERO_CHAMPION_ROLE_DUPLICATE =
  'That Discord role is already mapped to another hero in this league.';

export const HERO_CHAMPION_UNKNOWN_HERO = 'Unknown hero.';

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
    data: { heroChampionRolesEnabled: enabled },
  });
}

/** Upsert a staff-mapped Discord role for a hero in this league. */
export async function setLeagueHeroChampionRole(
  leagueId: string,
  heroId: number,
  discordRoleId: string,
): Promise<void> {
  await assertHeroChampionRolesSupported(leagueId);

  const hero = await prisma.hero.findUnique({ where: { id: heroId } });
  if (!hero) {
    throw new MatchServiceError(HERO_CHAMPION_UNKNOWN_HERO);
  }

  try {
    await prisma.leagueHeroChampionRole.upsert({
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
