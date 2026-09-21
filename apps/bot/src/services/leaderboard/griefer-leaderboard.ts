import { MatchStatus } from '@dbz/db';
import { prisma } from '../../lib/prisma.js';
import {
  LeaderboardServiceError,
  LEADERBOARD_PAGE_SIZE,
  LIVE_LEADERBOARD_MAX_SIZE,
  LIVE_LEADERBOARD_MIN_SIZE,
  clampPage,
} from './leaderboard.js';
import { assignCompetitionRanks } from './quitter-leaderboard.js';

export type GrieferLeaderboardDisplayMode = 'count' | 'rate' | 'both';
export type GrieferLeaderboardSortMode = 'count' | 'rate';

export type GrieferLeaderboardEntry = {
  rank: number;
  playerId: string;
  username: string;
  discordId: string | null;
  griefCount: number;
  completedCount: number;
  rate: number;
  pendingTaxKi: number;
};

export type GrieferLeaderboardPage = {
  entries: GrieferLeaderboardEntry[];
  page: number;
  totalPages: number;
  totalPlayers: number;
  display: GrieferLeaderboardDisplayMode;
  sort: GrieferLeaderboardSortMode;
};

export function assertGrieferLeaderboardSize(size: number): number {
  if (
    !Number.isInteger(size) ||
    size < LIVE_LEADERBOARD_MIN_SIZE ||
    size > LIVE_LEADERBOARD_MAX_SIZE
  ) {
    throw new LeaderboardServiceError('Griefer leaderboard size must be between 10 and 100.');
  }
  return size;
}

export function filterEligibleGrieferRows(
  rows: Omit<GrieferLeaderboardEntry, 'rank'>[],
  sort: GrieferLeaderboardSortMode,
): Omit<GrieferLeaderboardEntry, 'rank'>[] {
  if (sort === 'count') {
    return rows.filter((row) => row.griefCount >= 1);
  }
  return rows.filter((row) => row.completedCount >= 1);
}

export function sortGrieferRows(
  rows: Omit<GrieferLeaderboardEntry, 'rank'>[],
  sort: GrieferLeaderboardSortMode,
): Omit<GrieferLeaderboardEntry, 'rank'>[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    if (sort === 'count') {
      if (b.griefCount !== a.griefCount) return b.griefCount - a.griefCount;
      if (b.rate !== a.rate) return b.rate - a.rate;
      return a.username.localeCompare(b.username);
    }
    if (b.rate !== a.rate) return b.rate - a.rate;
    if (b.griefCount !== a.griefCount) return b.griefCount - a.griefCount;
    return a.username.localeCompare(b.username);
  });
  return copy;
}

export function paginateGrieferEntries(
  rows: GrieferLeaderboardEntry[],
  page: number,
  display: GrieferLeaderboardDisplayMode,
  sort: GrieferLeaderboardSortMode,
): GrieferLeaderboardPage {
  const totalPlayers = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalPlayers / LEADERBOARD_PAGE_SIZE) || 1);
  const safePage = clampPage(page, totalPages);
  const start = (safePage - 1) * LEADERBOARD_PAGE_SIZE;
  return {
    entries: rows.slice(start, start + LEADERBOARD_PAGE_SIZE),
    page: safePage,
    totalPages: totalPlayers === 0 ? 1 : totalPages,
    totalPlayers,
    display,
    sort,
  };
}

function aggregateRows(
  raw: Array<{
    playerId: string;
    isGriefer: boolean;
    isQuitter: boolean;
    grieferKiAccrued: number | null;
    match: { status: MatchStatus };
    player: { username: string; discordId: string | null };
  }>,
): Omit<GrieferLeaderboardEntry, 'rank'>[] {
  const byPlayer = new Map<
    string,
    {
      username: string;
      discordId: string | null;
      griefCount: number;
      completedCount: number;
      pendingTaxKi: number;
    }
  >();

  for (const row of raw) {
    let agg = byPlayer.get(row.playerId);
    if (!agg) {
      agg = {
        username: row.player.username,
        discordId: row.player.discordId,
        griefCount: 0,
        completedCount: 0,
        pendingTaxKi: 0,
      };
      byPlayer.set(row.playerId, agg);
    }
    if (row.isGriefer && !row.isQuitter) {
      agg.griefCount += 1;
      if (row.grieferKiAccrued != null && row.grieferKiAccrued > 0) {
        agg.pendingTaxKi += row.grieferKiAccrued;
      }
    }
    if (row.match.status === MatchStatus.COMPLETED) {
      agg.completedCount += 1;
    }
  }

  return [...byPlayer.entries()].map(([playerId, agg]) => ({
    playerId,
    username: agg.username,
    discordId: agg.discordId,
    griefCount: agg.griefCount,
    completedCount: agg.completedCount,
    rate: agg.completedCount > 0 ? agg.griefCount / agg.completedCount : 0,
    pendingTaxKi: agg.pendingTaxKi,
  }));
}

export async function loadGrieferLeaderboard(
  guildId: string,
  options: { display: GrieferLeaderboardDisplayMode; sort: GrieferLeaderboardSortMode },
): Promise<GrieferLeaderboardEntry[]> {
  const raw = await prisma.matchPlayer.findMany({
    where: {
      match: {
        league: { guildId },
        status: { in: [MatchStatus.COMPLETED, MatchStatus.CANCELLED] },
      },
    },
    select: {
      playerId: true,
      isGriefer: true,
      isQuitter: true,
      grieferKiAccrued: true,
      match: { select: { status: true } },
      player: { select: { username: true, discordId: true } },
    },
  });

  const aggregated = aggregateRows(raw);
  const eligible = filterEligibleGrieferRows(aggregated, options.sort);
  const sorted = sortGrieferRows(eligible, options.sort);
  return assignCompetitionRanks(sorted, (a, b) =>
    options.sort === 'count' ? a.griefCount === b.griefCount : a.rate === b.rate,
  );
}

export async function loadGrieferLeaderboardPage(
  guildId: string,
  page: number,
  display?: GrieferLeaderboardDisplayMode,
  sort?: GrieferLeaderboardSortMode,
): Promise<GrieferLeaderboardPage> {
  const cfg = await prisma.guildConfig.findUnique({
    where: { guildId },
    select: {
      grieferLeaderboardDisplay: true,
      grieferLeaderboardSort: true,
    },
  });
  const resolvedDisplay = display ?? cfg?.grieferLeaderboardDisplay ?? 'both';
  const resolvedSort = sort ?? cfg?.grieferLeaderboardSort ?? 'count';
  const rows = await loadGrieferLeaderboard(guildId, {
    display: resolvedDisplay,
    sort: resolvedSort,
  });
  return paginateGrieferEntries(rows, page, resolvedDisplay, resolvedSort);
}

export async function loadGrieferLeaderboardTop(
  guildId: string,
  size: number,
  display?: GrieferLeaderboardDisplayMode,
  sort?: GrieferLeaderboardSortMode,
): Promise<GrieferLeaderboardEntry[]> {
  const cfg = await prisma.guildConfig.findUnique({
    where: { guildId },
    select: { grieferLeaderboardDisplay: true, grieferLeaderboardSort: true },
  });
  const resolvedDisplay = display ?? cfg?.grieferLeaderboardDisplay ?? 'both';
  const resolvedSort = sort ?? cfg?.grieferLeaderboardSort ?? 'count';
  const rows = await loadGrieferLeaderboard(guildId, {
    display: resolvedDisplay,
    sort: resolvedSort,
  });
  return rows.slice(0, size);
}
