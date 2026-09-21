import type { Wos2BotReportItemRate } from '../../games/warcraft3_wos/index.js';
import { prisma } from '../../lib/prisma.js';

/** Upsert item names from a WOS2 bot report's ITEM_RATE lines. */
export async function upsertGameItems(
  gameId: string,
  itemRates: Wos2BotReportItemRate[],
): Promise<void> {
  if (itemRates.length === 0) {
    return;
  }

  await Promise.all(
    itemRates.map((item) =>
      prisma.gameItem.upsert({
        where: { gameId_objectId: { gameId, objectId: item.objectId } },
        create: { gameId, objectId: item.objectId, name: item.name },
        update: { name: item.name },
      }),
    ),
  );
}

/** Resolve display names for WC3 item object IDs in a game catalog. */
export async function resolveItemNames(
  gameId: string,
  objectIds: number[],
): Promise<Map<number, string>> {
  const unique = [...new Set(objectIds.filter((id) => id !== 0))];
  if (unique.length === 0) {
    return new Map();
  }

  const rows = await prisma.gameItem.findMany({
    where: { gameId, objectId: { in: unique } },
    select: { objectId: true, name: true },
  });

  return new Map(rows.map((row) => [row.objectId, row.name]));
}

/** Format an item for display, falling back to raw object id. */
export function formatItemDisplayName(objectId: number, names: Map<number, string>): string {
  return names.get(objectId) ?? `Item #${objectId}`;
}
