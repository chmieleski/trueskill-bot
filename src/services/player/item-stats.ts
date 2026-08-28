import { MatchResult, MatchStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { formatItemDisplayName, resolveItemNames } from '../game/game-item-catalog.js';
import { resolveHeroSelection, statsRowMatchesHeroSelection } from '../game/game-hero-catalog.js';
import { winRatePercent } from '../rating/rank-reset-display.js';

export type StatsWindow = 'last10' | 'overall';

export type ItemStatsRow = {
  matchId: string;
  result: typeof MatchResult.WIN | typeof MatchResult.LOSS;
  completedAt: Date | null;
  heroName: string | null;
  itemSlots: [number, number, number, number, number, number];
};

export type ItemWindowEntry = {
  objectId: number;
  displayName: string;
  buyRatePercent: number;
  winRatePercent: number | null;
  gamesWithItem: number;
};

export type ItemStatsResult = {
  heroDisplayName?: string;
  windows: Partial<Record<StatsWindow, ItemWindowEntry[]>>;
};

const TOP_ITEMS_LIMIT = 10;

function itemSlotsFromRow(row: {
  itemSlot1: number;
  itemSlot2: number;
  itemSlot3: number;
  itemSlot4: number;
  itemSlot5: number;
  itemSlot6: number;
}): ItemStatsRow['itemSlots'] {
  return [row.itemSlot1, row.itemSlot2, row.itemSlot3, row.itemSlot4, row.itemSlot5, row.itemSlot6];
}

/** Aggregate item buy rate and WR for one window of player-game rows. */
export function aggregateItemWindowStats(
  rows: ItemStatsRow[],
  names: Map<number, string>,
): ItemWindowEntry[] {
  const totalGames = rows.length;
  if (totalGames === 0) {
    return [];
  }

  const buckets = new Map<number, { gamesWithItem: number; wins: number }>();

  for (const row of rows) {
    const itemIds = new Set(row.itemSlots.filter((slot) => slot !== 0));
    for (const objectId of itemIds) {
      let bucket = buckets.get(objectId);
      if (!bucket) {
        bucket = { gamesWithItem: 0, wins: 0 };
        buckets.set(objectId, bucket);
      }
      bucket.gamesWithItem += 1;
      if (row.result === MatchResult.WIN) {
        bucket.wins += 1;
      }
    }
  }

  return [...buckets.entries()]
    .map(([objectId, bucket]) => ({
      objectId,
      displayName: formatItemDisplayName(objectId, names),
      buyRatePercent: Math.round((bucket.gamesWithItem / totalGames) * 1000) / 10,
      winRatePercent: winRatePercent(bucket.wins, bucket.gamesWithItem - bucket.wins),
      gamesWithItem: bucket.gamesWithItem,
    }))
    .sort(
      (left, right) =>
        right.buyRatePercent - left.buyRatePercent ||
        right.gamesWithItem - left.gamesWithItem ||
        left.displayName.localeCompare(right.displayName),
    )
    .slice(0, TOP_ITEMS_LIMIT);
}

function filterRowsToLast10Matches(rows: ItemStatsRow[]): ItemStatsRow[] {
  const matchCompletedAt = new Map<string, number>();
  for (const row of rows) {
    const ms = row.completedAt?.getTime() ?? 0;
    const existing = matchCompletedAt.get(row.matchId);
    if (existing === undefined || ms > existing) {
      matchCompletedAt.set(row.matchId, ms);
    }
  }

  const last10MatchIds = new Set(
    [...matchCompletedAt.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([matchId]) => matchId),
  );

  return rows.filter((row) => last10MatchIds.has(row.matchId));
}

/** Load item buy-rate stats for a league, optionally filtered to one hero. */
export async function loadItemStats(input: {
  leagueId: string;
  gameId: string;
  heroName?: string;
  windows: StatsWindow[];
}): Promise<ItemStatsResult> {
  const heroSelection = input.heroName
    ? await resolveHeroSelection(input.gameId, input.leagueId, input.heroName)
    : null;

  const rows = await prisma.matchPlayer.findMany({
    where: {
      result: { in: [MatchResult.WIN, MatchResult.LOSS] },
      match: { leagueId: input.leagueId, status: MatchStatus.COMPLETED },
      stats: { isNot: null },
    },
    select: {
      matchId: true,
      result: true,
      match: { select: { completedAt: true } },
      stats: {
        select: {
          heroName: true,
          heroObjectId: true,
          itemSlot1: true,
          itemSlot2: true,
          itemSlot3: true,
          itemSlot4: true,
          itemSlot5: true,
          itemSlot6: true,
        },
      },
    },
  });

  const mapped: ItemStatsRow[] = [];

  for (const row of rows) {
    if (row.result !== MatchResult.WIN && row.result !== MatchResult.LOSS) {
      continue;
    }
    const stats = row.stats;
    if (!stats) {
      continue;
    }

    if (heroSelection && !statsRowMatchesHeroSelection(stats, heroSelection)) {
      continue;
    }

    mapped.push({
      matchId: row.matchId,
      result: row.result,
      completedAt: row.match.completedAt,
      heroName: stats.heroName,
      itemSlots: itemSlotsFromRow(stats),
    });
  }

  const objectIds = mapped.flatMap((row) => row.itemSlots);
  const names = await resolveItemNames(input.gameId, objectIds);

  const windows: Partial<Record<StatsWindow, ItemWindowEntry[]>> = {};
  if (input.windows.includes('overall')) {
    windows.overall = aggregateItemWindowStats(mapped, names);
  }
  if (input.windows.includes('last10')) {
    windows.last10 = aggregateItemWindowStats(filterRowsToLast10Matches(mapped), names);
  }

  return {
    heroDisplayName: heroSelection?.displayName,
    windows,
  };
}
