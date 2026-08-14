import { prisma } from '../lib/prisma.js';
import { MatchServiceError } from './match-service.js';

export const MIN_WC3STATS_SLOT = 0;
export const MAX_WC3STATS_SLOT = 23;
export const MIN_HERO_SLOT = 1;
export const MAX_HERO_SLOT = 12;

export type GuildWc3statsSlotMapping = {
  wc3statsSlot: number;
  heroId: number;
};

/** wc3stats `slots[]` index → bot hero/slot (1–12). */
export type Wc3statsHeroSlotMap = ReadonlyMap<number, number>;

/**
 * Classic UDBR color-order indices → hero slots.
 * Z Fighters: red/blue/teal/purple/orange/green → 1–6
 * Evils: yellow/pink/gray/light_blue/dark_green/brown → 7–12
 * Referee (12–15) left unmapped.
 */
export const UDBR_WC3STATS_SLOT_MAP: ReadonlyArray<GuildWc3statsSlotMapping> = [
  { wc3statsSlot: 0, heroId: 1 },
  { wc3statsSlot: 1, heroId: 2 },
  { wc3statsSlot: 2, heroId: 3 },
  { wc3statsSlot: 3, heroId: 4 },
  { wc3statsSlot: 5, heroId: 5 },
  { wc3statsSlot: 6, heroId: 6 },
  { wc3statsSlot: 4, heroId: 7 },
  { wc3statsSlot: 7, heroId: 8 },
  { wc3statsSlot: 8, heroId: 9 },
  { wc3statsSlot: 9, heroId: 10 },
  { wc3statsSlot: 10, heroId: 11 },
  { wc3statsSlot: 11, heroId: 12 },
];

export function assertWc3statsSlotInRange(wc3statsSlot: number): void {
  if (
    !Number.isInteger(wc3statsSlot) ||
    wc3statsSlot < MIN_WC3STATS_SLOT ||
    wc3statsSlot > MAX_WC3STATS_SLOT
  ) {
    throw new MatchServiceError(
      `wc3_slot must be an integer between ${MIN_WC3STATS_SLOT} and ${MAX_WC3STATS_SLOT}.`,
    );
  }
}

export function assertHeroSlotInRange(heroId: number): void {
  if (!Number.isInteger(heroId) || heroId < MIN_HERO_SLOT || heroId > MAX_HERO_SLOT) {
    throw new MatchServiceError(
      `hero_slot must be an integer between ${MIN_HERO_SLOT} and ${MAX_HERO_SLOT}.`,
    );
  }
}

/**
 * Parse `0=1,1=2,4=7` style entries into mappings.
 * Later pairs win on duplicate wc3 slots; duplicate hero targets are rejected.
 */
export function parseWc3statsSlotMapEntries(raw: string): GuildWc3statsSlotMapping[] {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new MatchServiceError(
      'entries must look like `0=1,1=2,4=7` (wc3_slot=hero_slot pairs).',
    );
  }

  const pairs = trimmed.split(/[,;\s]+/).filter((part) => part !== '');
  const byWc3 = new Map<number, number>();

  for (const pair of pairs) {
    const match = /^(\d+)\s*[=:]\s*(\d+)$/.exec(pair);
    if (!match) {
      throw new MatchServiceError(
        `Invalid mapping \`${pair}\`. Use \`wc3_slot=hero_slot\` (example: \`4=7\`).`,
      );
    }

    const wc3statsSlot = Number(match[1]);
    const heroId = Number(match[2]);
    assertWc3statsSlotInRange(wc3statsSlot);
    assertHeroSlotInRange(heroId);
    byWc3.set(wc3statsSlot, heroId);
  }

  const mappings = [...byWc3.entries()].map(([wc3statsSlot, heroId]) => ({
    wc3statsSlot,
    heroId,
  }));
  assertUniqueHeroTargets(mappings);
  return mappings.sort((a, b) => a.wc3statsSlot - b.wc3statsSlot);
}

export function assertUniqueHeroTargets(mappings: GuildWc3statsSlotMapping[]): void {
  const seen = new Map<number, number>();
  for (const entry of mappings) {
    const prior = seen.get(entry.heroId);
    if (prior !== undefined) {
      throw new MatchServiceError(
        `Hero slot ${entry.heroId} is mapped twice (wc3 slots ${prior} and ${entry.wc3statsSlot}).`,
      );
    }
    seen.set(entry.heroId, entry.wc3statsSlot);
  }
}

export function toWc3statsHeroSlotMap(
  mappings: ReadonlyArray<GuildWc3statsSlotMapping>,
): Wc3statsHeroSlotMap {
  return new Map(mappings.map((entry) => [entry.wc3statsSlot, entry.heroId]));
}

export function formatWc3statsSlotMapLines(
  mappings: ReadonlyArray<GuildWc3statsSlotMapping>,
): string[] {
  if (mappings.length === 0) {
    return ['`unset` (legacy: wc3stats index + 1 for slots 1–12)'];
  }

  return [...mappings]
    .sort((a, b) => a.heroId - b.heroId)
    .map((entry) => `wc3 \`${entry.wc3statsSlot}\` → hero \`${entry.heroId}\``);
}

async function ensureGuildConfig(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId },
    update: {},
  });
}

export async function listGuildWc3statsSlotMaps(
  guildId: string,
): Promise<GuildWc3statsSlotMapping[]> {
  const rows = await prisma.guildWc3statsSlotMap.findMany({
    where: { guildId },
    orderBy: [{ heroId: 'asc' }, { wc3statsSlot: 'asc' }],
    select: { wc3statsSlot: true, heroId: true },
  });
  return rows;
}

export async function loadGuildWc3statsHeroSlotMap(
  guildId: string,
): Promise<Wc3statsHeroSlotMap | null> {
  const rows = await listGuildWc3statsSlotMaps(guildId);
  if (rows.length === 0) {
    return null;
  }
  return toWc3statsHeroSlotMap(rows);
}

/**
 * Upsert one wc3stats index → hero mapping. Rejects if another wc3 index already owns that hero.
 */
export async function setGuildWc3statsSlotMap(
  guildId: string,
  wc3statsSlot: number,
  heroId: number,
): Promise<void> {
  assertWc3statsSlotInRange(wc3statsSlot);
  assertHeroSlotInRange(heroId);
  await ensureGuildConfig(guildId);

  const conflict = await prisma.guildWc3statsSlotMap.findFirst({
    where: {
      guildId,
      heroId,
      NOT: { wc3statsSlot },
    },
    select: { wc3statsSlot: true },
  });

  if (conflict) {
    throw new MatchServiceError(
      `Hero slot ${heroId} is already mapped from wc3 slot ${conflict.wc3statsSlot}. Clear it first.`,
    );
  }

  await prisma.guildWc3statsSlotMap.upsert({
    where: {
      guildId_wc3statsSlot: { guildId, wc3statsSlot },
    },
    create: { guildId, wc3statsSlot, heroId },
    update: { heroId },
  });
}

/** Replace the entire guild mapping (atomic). */
export async function replaceGuildWc3statsSlotMaps(
  guildId: string,
  mappings: GuildWc3statsSlotMapping[],
): Promise<void> {
  assertUniqueHeroTargets(mappings);
  for (const entry of mappings) {
    assertWc3statsSlotInRange(entry.wc3statsSlot);
    assertHeroSlotInRange(entry.heroId);
  }

  await ensureGuildConfig(guildId);

  await prisma.$transaction(async (tx) => {
    await tx.guildWc3statsSlotMap.deleteMany({ where: { guildId } });
    if (mappings.length > 0) {
      await tx.guildWc3statsSlotMap.createMany({
        data: mappings.map((entry) => ({
          guildId,
          wc3statsSlot: entry.wc3statsSlot,
          heroId: entry.heroId,
        })),
      });
    }
  });
}

export async function clearGuildWc3statsSlotMap(
  guildId: string,
  wc3statsSlot: number,
): Promise<boolean> {
  assertWc3statsSlotInRange(wc3statsSlot);
  const result = await prisma.guildWc3statsSlotMap.deleteMany({
    where: { guildId, wc3statsSlot },
  });
  return result.count > 0;
}

export async function clearAllGuildWc3statsSlotMaps(guildId: string): Promise<number> {
  const result = await prisma.guildWc3statsSlotMap.deleteMany({ where: { guildId } });
  return result.count;
}
