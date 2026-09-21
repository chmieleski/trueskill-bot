import { prisma } from '../../lib/prisma.js';
import { MatchServiceError } from '../match/match-service.js';
import { assertLeagueAllowsWc3stats } from '../lobby/register-lobby-source.js';

export const MIN_WC3STATS_SLOT = 0;
export const MAX_WC3STATS_SLOT = 23;
export const MIN_HERO_SLOT = 1;
export const MAX_HERO_SLOT = 12;

/** Shape shared by all slot-map CRUD helpers. */
export type GuildWc3statsSlotMapping = {
  wc3statsSlot: number;
  heroId: number;
};

/** wc3stats `slots[]` index → bot hero/slot (1–12). */
export type Wc3statsHeroSlotMap = ReadonlyMap<number, number>;

/**
 * Classic UDBR color indices (1-based in lobby UI): `1 2 3 4 6 7 | 5 8 9 10 11 12`
 * → heroes 1–6 (Z Fighters) and 7–12 (Evils). Referee colors 13–16 unmapped.
 * Stored as 0-based wc3stats `slots[]` indices.
 */
export const UDBR_WC3STATS_SLOT_MAP: ReadonlyArray<GuildWc3statsSlotMapping> = [
  // Z Fighters: colors 1,2,3,4,6,7 → heroes 1–6
  { wc3statsSlot: 0, heroId: 1 },
  { wc3statsSlot: 1, heroId: 2 },
  { wc3statsSlot: 2, heroId: 3 },
  { wc3statsSlot: 3, heroId: 4 },
  { wc3statsSlot: 5, heroId: 5 },
  { wc3statsSlot: 6, heroId: 6 },
  // Evils: colors 5,8,9,10,11,12 → heroes 7–12
  { wc3statsSlot: 4, heroId: 7 },
  { wc3statsSlot: 7, heroId: 8 },
  { wc3statsSlot: 8, heroId: 9 },
  { wc3statsSlot: 9, heroId: 10 },
  { wc3statsSlot: 10, heroId: 11 },
  { wc3statsSlot: 11, heroId: 12 },
];

/**
 * WOS player colors (wc3stats index → bot slot), verified on Anime_WOS2_0.30:
 * Team A (wc3 team 0): red, blue, teal, purple, yellow → slots 1–5
 * Team B (wc3 team 1): orange, green, pink, gray, light_blue → slots 6–10
 */
export { WOS_WC3STATS_SLOT_MAP } from '../../games/warcraft3_wos/wos-slot-map.js';

/** Regex source copied into League by the WOS preset (not a process env default). */
export const WOS_MAP_PATTERN = 'anime.?wos2';

/** map.sha1 for Anime_WOS2_0.30 (wc3stats detail, not list hash). Add more builds comma-separated. */
export const WOS_MAP_SHA1 = 'ee61b21fca7333db0531c8eee5e33b1acafd61ed';

/** Regex source copied into GuildConfig by the UDBR preset (not a process env default). */
export const UDBR_MAP_PATTERN = 'ultimate.?dragon.?ball.?reborn|udbr';

/** Comma-separated map.sha1 allowlist for UDBR 2.4f (gamelist detail, not list hash). */
export const UDBR_MAP_SHA1 = '19783c6259e86253a8c940ede63a87e18204bd94';

export function parseWc3statsMapSha1(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

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
    throw new MatchServiceError('entries must look like `0=1,1=2,4=7` (wc3_slot=hero_slot pairs).');
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

export async function listLeagueWc3statsSlotMaps(
  leagueId: string,
): Promise<GuildWc3statsSlotMapping[]> {
  const rows = await prisma.leagueWc3statsSlotMap.findMany({
    where: { leagueId },
    orderBy: [{ heroId: 'asc' }, { wc3statsSlot: 'asc' }],
    select: { wc3statsSlot: true, heroId: true },
  });
  return rows;
}

export async function loadLeagueWc3statsHeroSlotMap(
  leagueId: string,
): Promise<Wc3statsHeroSlotMap | null> {
  const rows = await listLeagueWc3statsSlotMaps(leagueId);
  if (rows.length === 0) {
    return null;
  }
  return toWc3statsHeroSlotMap(rows);
}

/**
 * Upsert one wc3stats index → hero mapping for a league.
 * Rejects if another wc3 index already owns that hero.
 */
export async function setLeagueWc3statsSlotMap(
  leagueId: string,
  wc3statsSlot: number,
  heroId: number,
): Promise<void> {
  await assertLeagueAllowsWc3stats(leagueId);
  assertWc3statsSlotInRange(wc3statsSlot);
  assertHeroSlotInRange(heroId);

  const conflict = await prisma.leagueWc3statsSlotMap.findFirst({
    where: {
      leagueId,
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

  await prisma.leagueWc3statsSlotMap.upsert({
    where: {
      leagueId_wc3statsSlot: { leagueId, wc3statsSlot },
    },
    create: { leagueId, wc3statsSlot, heroId },
    update: { heroId },
  });
}

/** Replace the entire league slot mapping (atomic). */
export async function replaceLeagueWc3statsSlotMaps(
  leagueId: string,
  mappings: GuildWc3statsSlotMapping[],
): Promise<void> {
  await assertLeagueAllowsWc3stats(leagueId);
  assertUniqueHeroTargets(mappings);
  for (const entry of mappings) {
    assertWc3statsSlotInRange(entry.wc3statsSlot);
    assertHeroSlotInRange(entry.heroId);
  }

  await prisma.$transaction(async (tx) => {
    await tx.leagueWc3statsSlotMap.deleteMany({ where: { leagueId } });
    if (mappings.length > 0) {
      await tx.leagueWc3statsSlotMap.createMany({
        data: mappings.map((entry) => ({
          leagueId,
          wc3statsSlot: entry.wc3statsSlot,
          heroId: entry.heroId,
        })),
      });
    }
  });
}

export async function clearLeagueWc3statsSlotMap(
  leagueId: string,
  wc3statsSlot: number,
): Promise<boolean> {
  await assertLeagueAllowsWc3stats(leagueId);
  assertWc3statsSlotInRange(wc3statsSlot);
  const result = await prisma.leagueWc3statsSlotMap.deleteMany({
    where: { leagueId, wc3statsSlot },
  });
  return result.count > 0;
}

export async function clearAllLeagueWc3statsSlotMaps(leagueId: string): Promise<number> {
  const result = await prisma.leagueWc3statsSlotMap.deleteMany({ where: { leagueId } });
  return result.count;
}
