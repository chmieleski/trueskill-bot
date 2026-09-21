import { MatchStatus } from '@dbz/db';
import { prisma } from '../../lib/prisma.js';
import {
  LeaderboardServiceError,
  LEADERBOARD_PAGE_SIZE,
  LIVE_LEADERBOARD_MAX_SIZE,
  LIVE_LEADERBOARD_MIN_SIZE,
  clampPage,
} from './leaderboard.js';

export type QuitterLeaderboardDisplayMode = 'count' | 'rate' | 'both';
export type QuitterLeaderboardSortMode = 'count' | 'rate';

export type QuitterLeaderboardEntry = {
  rank: number;
  playerId: string;
  username: string;
  discordId: string | null;
  quitCount: number;
  completedCount: number;
  rate: number;
};

export type QuitterLeaderboardPage = {
  entries: QuitterLeaderboardEntry[];
  page: number;
  totalPages: number;
  totalPlayers: number;
  display: QuitterLeaderboardDisplayMode;
  sort: QuitterLeaderboardSortMode;
};

export function assertQuitterLeaderboardSize(size: number): number {
  if (
    !Number.isInteger(size) ||
    size < LIVE_LEADERBOARD_MIN_SIZE ||
    size > LIVE_LEADERBOARD_MAX_SIZE
  ) {
    throw new LeaderboardServiceError('Quitter leaderboard size must be between 10 and 100.');
  }
  return size;
}

export function assignCompetitionRanks<T>(
  rows: T[],
  isSameRank: (a: T, b: T) => boolean,
): (T & { rank: number })[] {
  const result: (T & { rank: number })[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (i === 0 || !isSameRank(row, rows[i - 1]!)) {
      result.push({ ...row, rank: i + 1 });
    } else {
      result.push({ ...row, rank: result[i - 1]!.rank });
    }
  }
  return result;
}

export function filterEligibleQuitterRows(
  rows: Omit<QuitterLeaderboardEntry, 'rank'>[],
  sort: QuitterLeaderboardSortMode,
): Omit<QuitterLeaderboardEntry, 'rank'>[] {
  if (sort === 'count') {
    return rows.filter((row) => row.quitCount >= 1);
  }
  return rows.filter((row) => row.completedCount >= 1);
}

export function sortQuitterRows(
  rows: Omit<QuitterLeaderboardEntry, 'rank'>[],
  sort: QuitterLeaderboardSortMode,
): Omit<QuitterLeaderboardEntry, 'rank'>[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    if (sort === 'count') {
      if (b.quitCount !== a.quitCount) return b.quitCount - a.quitCount;
      if (b.rate !== a.rate) return b.rate - a.rate;
      return a.username.localeCompare(b.username);
    }
    if (b.rate !== a.rate) return b.rate - a.rate;
    if (b.quitCount !== a.quitCount) return b.quitCount - a.quitCount;
    return a.username.localeCompare(b.username);
  });
  return copy;
}

export function paginateQuitterEntries(
  rows: QuitterLeaderboardEntry[],
  page: number,
  display: QuitterLeaderboardDisplayMode,
  sort: QuitterLeaderboardSortMode,
): QuitterLeaderboardPage {
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
    isQuitter: boolean;
    match: { status: MatchStatus };
    player: { username: string; discordId: string | null };
  }>,
): Omit<QuitterLeaderboardEntry, 'rank'>[] {
  const byPlayer = new Map<
    string,
    { username: string; discordId: string | null; quitCount: number; completedCount: number }
  >();

  for (const row of raw) {
    let agg = byPlayer.get(row.playerId);
    if (!agg) {
      agg = {
        username: row.player.username,
        discordId: row.player.discordId,
        quitCount: 0,
        completedCount: 0,
      };
      byPlayer.set(row.playerId, agg);
    }
    if (row.isQuitter) {
      agg.quitCount += 1;
    }
    if (row.match.status === MatchStatus.COMPLETED) {
      agg.completedCount += 1;
    }
  }

  return [...byPlayer.entries()].map(([playerId, agg]) => ({
    playerId,
    username: agg.username,
    discordId: agg.discordId,
    quitCount: agg.quitCount,
    completedCount: agg.completedCount,
    rate: agg.completedCount > 0 ? agg.quitCount / agg.completedCount : 0,
  }));
}

export async function loadQuitterLeaderboard(
  guildId: string,
  options: { display: QuitterLeaderboardDisplayMode; sort: QuitterLeaderboardSortMode },
): Promise<QuitterLeaderboardEntry[]> {
  const raw = await prisma.matchPlayer.findMany({
    where: {
      match: {
        league: { guildId },
        status: { in: [MatchStatus.COMPLETED, MatchStatus.CANCELLED] },
      },
    },
    select: {
      playerId: true,
      isQuitter: true,
      match: { select: { status: true } },
      player: { select: { username: true, discordId: true } },
    },
  });

  const aggregated = aggregateRows(raw);
  const eligible = filterEligibleQuitterRows(aggregated, options.sort);
  const sorted = sortQuitterRows(eligible, options.sort);
  return assignCompetitionRanks(sorted, (a, b) =>
    options.sort === 'count' ? a.quitCount === b.quitCount : a.rate === b.rate,
  );
}

export async function loadQuitterLeaderboardPage(
  guildId: string,
  page: number,
  display?: QuitterLeaderboardDisplayMode,
  sort?: QuitterLeaderboardSortMode,
): Promise<QuitterLeaderboardPage> {
  const cfg = await prisma.guildConfig.findUnique({
    where: { guildId },
    select: {
      quitterLeaderboardDisplay: true,
      quitterLeaderboardSort: true,
    },
  });
  const resolvedDisplay = display ?? cfg?.quitterLeaderboardDisplay ?? 'both';
  const resolvedSort = sort ?? cfg?.quitterLeaderboardSort ?? 'count';
  const rows = await loadQuitterLeaderboard(guildId, {
    display: resolvedDisplay,
    sort: resolvedSort,
  });
  return paginateQuitterEntries(rows, page, resolvedDisplay, resolvedSort);
}

export async function loadQuitterLeaderboardTop(
  guildId: string,
  size: number,
  display?: QuitterLeaderboardDisplayMode,
  sort?: QuitterLeaderboardSortMode,
): Promise<QuitterLeaderboardEntry[]> {
  const cfg = await prisma.guildConfig.findUnique({
    where: { guildId },
    select: { quitterLeaderboardDisplay: true, quitterLeaderboardSort: true },
  });
  const resolvedDisplay = display ?? cfg?.quitterLeaderboardDisplay ?? 'both';
  const resolvedSort = sort ?? cfg?.quitterLeaderboardSort ?? 'count';
  const rows = await loadQuitterLeaderboard(guildId, {
    display: resolvedDisplay,
    sort: resolvedSort,
  });
  return rows.slice(0, size);
}
