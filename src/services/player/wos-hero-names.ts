import { MatchStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { formatHeroDisplayName, resolveHeroDisplayNames } from '../game/game-hero-catalog.js';
import { normalizeHeroNameKey } from './hero-stats.js';

/** Distinct WOS hero display names from completed matches in a league. */
export async function listWosHeroNamesForLeague(
  leagueId: string,
  gameId: string,
): Promise<string[]> {
  const rows = await prisma.matchPlayer.findMany({
    where: {
      match: { leagueId, status: MatchStatus.COMPLETED },
      stats: { heroName: { not: null } },
    },
    select: {
      stats: { select: { heroName: true, heroObjectId: true } },
    },
  });

  const objectIds = new Set<number>();
  const orphanNames = new Map<string, string>();

  for (const row of rows) {
    const stats = row.stats;
    if (!stats) {
      continue;
    }
    const heroName = stats.heroName?.trim();
    if (!heroName) {
      continue;
    }
    if (stats.heroObjectId != null) {
      objectIds.add(stats.heroObjectId);
      continue;
    }
    const key = normalizeHeroNameKey(heroName);
    if (!orphanNames.has(key)) {
      orphanNames.set(key, heroName);
    }
  }

  const catalogNames = await resolveHeroDisplayNames(gameId, [...objectIds]);
  const displayNames = new Set<string>();

  for (const objectId of objectIds) {
    const fallback = rows
      .map((row) => row.stats)
      .find((stats) => stats?.heroObjectId === objectId)?.heroName;
    displayNames.add(formatHeroDisplayName(objectId, catalogNames, fallback));
  }

  for (const name of orphanNames.values()) {
    displayNames.add(name);
  }

  return [...displayNames].sort((left, right) => left.localeCompare(right));
}
