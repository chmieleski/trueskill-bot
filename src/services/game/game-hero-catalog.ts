import { MatchStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { normalizeHeroNameKey } from '../player/hero-stats.js';

export class GameHeroCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameHeroCatalogError';
  }
}

export type HeroSelection = {
  objectId: number | null;
  nameKey: string;
  displayName: string;
};

/** Insert heroes from a WOS2 report; never overwrite existing catalog names (mod renames). */
export async function upsertGameHeroesFromReport(
  gameId: string,
  heroes: Array<{ objectId: number | null; name: string | null }>,
): Promise<void> {
  const unique = new Map<number, string>();
  for (const hero of heroes) {
    if (hero.objectId == null) {
      continue;
    }
    const name = hero.name?.trim();
    if (!name) {
      continue;
    }
    unique.set(hero.objectId, name);
  }

  if (unique.size === 0) {
    return;
  }

  await Promise.all(
    [...unique.entries()].map(([objectId, name]) =>
      prisma.gameHero.upsert({
        where: { gameId_objectId: { gameId, objectId } },
        create: { gameId, objectId, name },
        update: {},
      }),
    ),
  );
}

/** Resolve one hero display name from the catalog, falling back to the report string. */
export function formatHeroDisplayName(
  objectId: number | null | undefined,
  names: Map<number, string>,
  fallback: string | null | undefined,
): string {
  if (objectId != null) {
    const catalogName = names.get(objectId);
    if (catalogName) {
      return catalogName;
    }
  }
  const trimmed = fallback?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'Unknown hero';
}

/** Batch-resolve catalog display names for WC3 hero object IDs. */
export async function resolveHeroDisplayNames(
  gameId: string,
  objectIds: number[],
): Promise<Map<number, string>> {
  const unique = [...new Set(objectIds.filter((id) => id !== 0))];
  if (unique.length === 0) {
    return new Map();
  }

  const rows = await prisma.gameHero.findMany({
    where: { gameId, objectId: { in: unique } },
    select: { objectId: true, name: true },
  });

  return new Map(rows.map((row) => [row.objectId, row.name]));
}

/** Resolve a single hero display name. */
export async function resolveHeroDisplayName(
  gameId: string,
  objectId: number,
  fallback?: string | null,
): Promise<string> {
  const names = await resolveHeroDisplayNames(gameId, [objectId]);
  return formatHeroDisplayName(objectId, names, fallback);
}

/** True when a stats row belongs to the resolved hero selection. */
export function statsRowMatchesHeroSelection(
  stats: { heroName: string | null; heroObjectId: number | null },
  selection: HeroSelection,
): boolean {
  if (selection.objectId != null && stats.heroObjectId === selection.objectId) {
    return true;
  }
  if (selection.objectId != null) {
    return false;
  }
  const heroName = stats.heroName?.trim();
  return heroName != null && normalizeHeroNameKey(heroName) === selection.nameKey;
}

/**
 * Resolve a user-provided hero name to an object id (when known) and display label.
 * Matches catalog display names, then report names in the league, then name-only rows.
 */
export async function resolveHeroSelection(
  gameId: string,
  leagueId: string,
  heroName: string,
): Promise<HeroSelection | null> {
  const trimmed = heroName.trim();
  const nameKey = normalizeHeroNameKey(trimmed);
  if (!nameKey) {
    return null;
  }

  const catalogMatch = await prisma.gameHero.findFirst({
    where: { gameId, name: { equals: trimmed, mode: 'insensitive' } },
    select: { objectId: true, name: true },
  });
  if (catalogMatch) {
    return {
      objectId: catalogMatch.objectId,
      nameKey,
      displayName: catalogMatch.name,
    };
  }

  const statRow = await prisma.matchPlayerStats.findFirst({
    where: {
      heroName: { equals: trimmed, mode: 'insensitive' },
      heroObjectId: { not: null },
      matchPlayer: {
        match: { leagueId, status: MatchStatus.COMPLETED },
      },
    },
    select: { heroObjectId: true, heroName: true },
  });
  if (statRow?.heroObjectId != null) {
    const displayName = await resolveHeroDisplayName(
      gameId,
      statRow.heroObjectId,
      statRow.heroName,
    );
    return {
      objectId: statRow.heroObjectId,
      nameKey,
      displayName,
    };
  }

  return { objectId: null, nameKey, displayName: trimmed };
}

/** Set a shorter display name for a WOS hero (catalog row or legacy name-only stats). */
export async function renameGameHeroDisplayName(input: {
  gameId: string;
  leagueId: string;
  currentName: string;
  displayName: string;
}): Promise<{ objectId: number | null; displayName: string }> {
  const newName = input.displayName.trim();
  if (!newName) {
    throw new GameHeroCatalogError('Display name cannot be empty.');
  }

  const selection = await resolveHeroSelection(input.gameId, input.leagueId, input.currentName);
  if (!selection) {
    throw new GameHeroCatalogError(
      `No hero found matching "${input.currentName.trim()}" in this league.`,
    );
  }

  if (selection.objectId != null) {
    await prisma.gameHero.upsert({
      where: { gameId_objectId: { gameId: input.gameId, objectId: selection.objectId } },
      create: { gameId: input.gameId, objectId: selection.objectId, name: newName },
      update: { name: newName },
    });
    return { objectId: selection.objectId, displayName: newName };
  }

  const updated = await prisma.matchPlayerStats.updateMany({
    where: {
      heroName: { equals: input.currentName.trim(), mode: 'insensitive' },
      heroObjectId: null,
      matchPlayer: { match: { leagueId: input.leagueId } },
    },
    data: { heroName: newName },
  });
  if (updated.count === 0) {
    throw new GameHeroCatalogError(
      `No hero found matching "${input.currentName.trim()}" in this league.`,
    );
  }

  return { objectId: null, displayName: newName };
}
