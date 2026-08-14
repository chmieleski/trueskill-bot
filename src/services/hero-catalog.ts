import { prisma } from '../lib/prisma.js';

export type HeroCatalogEntry = {
  id: number;
  name: string;
  color: string | null;
};

export class HeroCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeroCatalogError';
  }
}

let catalogCache: HeroCatalogEntry[] | null = null;

/** Load all heroes from the database (cached per process). Never seeds data. */
export async function loadHeroCatalog(): Promise<HeroCatalogEntry[]> {
  if (!catalogCache) {
    catalogCache = await prisma.hero.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, name: true, color: true },
    });
  }

  return catalogCache;
}

export function clearHeroCatalogCache(): void {
  catalogCache = null;
}

export async function assertHeroCatalogReady(): Promise<void> {
  const catalog = await loadHeroCatalog();
  if (catalog.length === 0) {
    throw new HeroCatalogError(
      'No heroes are configured in the database. Add the hero roster first.',
    );
  }
}

/** Lobby slot doubles as hero id (1–12). */
export async function assertHeroExists(heroId: number): Promise<void> {
  const hero = await prisma.hero.findUnique({ where: { id: heroId } });
  if (!hero) {
    throw new HeroCatalogError(
      `No hero configured for slot ${heroId}. Add heroes in the database first.`,
    );
  }
}

export async function getHeroDisplayName(heroId: number): Promise<string> {
  const catalog = await loadHeroCatalog();
  return catalog.find((hero) => hero.id === heroId)?.name ?? `Hero ${heroId}`;
}

export async function resolveHeroByName(
  name: string,
): Promise<{ heroId: number; heroName: string } | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }

  const asId = Number.parseInt(trimmed, 10);
  if (Number.isInteger(asId) && asId >= 1 && asId <= 12) {
    const hero = await prisma.hero.findUnique({ where: { id: asId } });
    if (hero) {
      return { heroId: hero.id, heroName: hero.name };
    }
  }

  const hero = await prisma.hero.findFirst({
    where: { name: { equals: trimmed, mode: 'insensitive' } },
  });
  return hero ? { heroId: hero.id, heroName: hero.name } : null;
}

export async function listHeroNames(): Promise<{ id: number; name: string }[]> {
  const catalog = await loadHeroCatalog();
  return catalog.map(({ id, name }) => ({ id, name }));
}

export async function listCatalogHeroIds(): Promise<number[]> {
  const catalog = await loadHeroCatalog();
  return catalog.map((hero) => hero.id);
}
