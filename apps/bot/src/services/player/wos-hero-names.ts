import { MatchStatus } from '@dbz/db';
import { prisma } from '../../lib/prisma.js';
import { formatHeroDisplayName, resolveHeroDisplayNames } from '../game/game-hero-catalog.js';
import { normalizeHeroNameKey } from './hero-stats.js';

export type WosHeroListEntry = {
  objectId: number | null;
  name: string;
};

/** Distinct heroes in completed league matches; sorted by name. */
export async function listWosHeroesForLeague(
  leagueId: string,
  gameId: string,
): Promise<WosHeroListEntry[]> {
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
  /** Prefer objectId entries when display names collide (matches prior Set behavior). */
  const byDisplayName = new Map<string, WosHeroListEntry>();

  for (const objectId of objectIds) {
    const fallback = rows
      .map((row) => row.stats)
      .find((stats) => stats?.heroObjectId === objectId)?.heroName;
    const name = formatHeroDisplayName(objectId, catalogNames, fallback);
    if (!byDisplayName.has(name)) {
      byDisplayName.set(name, { objectId, name });
    }
  }

  for (const name of orphanNames.values()) {
    if (!byDisplayName.has(name)) {
      byDisplayName.set(name, { objectId: null, name });
    }
  }

  return [...byDisplayName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Distinct WOS hero display names from completed matches in a league. */
export async function listWosHeroNamesForLeague(
  leagueId: string,
  gameId: string,
): Promise<string[]> {
  const heroes = await listWosHeroesForLeague(leagueId, gameId);
  return heroes.map((hero) => hero.name);
}
