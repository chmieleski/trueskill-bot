import { MatchResult, MatchStatus } from '@prisma/client';
import { loadHeroCatalog } from './hero-catalog.js';
import { prisma } from '../lib/prisma.js';
import { displayOrdinal } from './rating-math.js';

export const LEADERBOARD_PAGE_SIZE = 10;
export const LIVE_LEADERBOARD_SIZE = 10;
export const HERO_COMPACT_TOP = 3;
export const HERO_SINGLE_TOP = 10;

export class LeaderboardServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaderboardServiceError';
  }
}

export type OverallLeaderboardEntry = {
  rank: number;
  playerId: string;
  username: string;
  ki: number;
  games: number;
  discordId: string | null;
};

export type HeroLeaderboardEntry = {
  rank: number;
  playerId: string;
  username: string;
  ki: number;
  matchesPlayed: number;
};

export type OverallLeaderboardPage = {
  entries: OverallLeaderboardEntry[];
  page: number;
  totalPages: number;
  totalPlayers: number;
};

export type HeroBoardSlice = {
  heroId: number;
  heroName: string;
  entries: HeroLeaderboardEntry[];
};

/** Clamp page to [1, totalPages]; totalPages 0 → page 1. */
export function clampPage(page: number, totalPages: number): number {
  if (totalPages <= 0) {
    return 1;
  }
  return Math.min(Math.max(1, page), totalPages);
}

/** Assign competition ranks on a list already sorted by ki desc. */
export function assignSortedRanks<T extends { ki: number }>(
  rows: T[],
): (T & { rank: number })[] {
  const result: (T & { rank: number })[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (i === 0 || row.ki !== rows[i - 1]!.ki) {
      result.push({ ...row, rank: i + 1 });
    } else {
      result.push({ ...row, rank: result[i - 1]!.rank });
    }
  }
  return result;
}

export function paginateOverall(
  rows: OverallLeaderboardEntry[],
  page: number,
): OverallLeaderboardPage {
  const totalPlayers = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalPlayers / LEADERBOARD_PAGE_SIZE));
  const safePage = clampPage(page, totalPages);
  const start = (safePage - 1) * LEADERBOARD_PAGE_SIZE;
  return {
    entries: rows.slice(start, start + LEADERBOARD_PAGE_SIZE),
    page: safePage,
    totalPages,
    totalPlayers,
  };
}

async function loadEligibleOverallRows(): Promise<OverallLeaderboardEntry[]> {
  const [ratings, gameCounts] = await Promise.all([
    prisma.playerRating.findMany({
      include: {
        player: { select: { id: true, username: true, discordId: true } },
      },
    }),
    prisma.matchPlayer.groupBy({
      by: ['playerId'],
      where: {
        match: { status: MatchStatus.COMPLETED },
        result: { in: [MatchResult.WIN, MatchResult.LOSS] },
      },
      _count: { _all: true },
    }),
  ]);

  const gamesByPlayer = new Map(
    gameCounts.map((row) => [row.playerId, row._count._all]),
  );

  const sorted = ratings
    .map((row) => ({
      playerId: row.playerId,
      username: row.player.username,
      discordId: row.player.discordId,
      ki: displayOrdinal(row.mu, row.sigma),
      games: gamesByPlayer.get(row.playerId) ?? 0,
    }))
    .filter((row) => row.games >= 1)
    .sort((a, b) => b.ki - a.ki || a.username.localeCompare(b.username));

  return assignSortedRanks(sorted).map((row) => ({
    rank: row.rank,
    playerId: row.playerId,
    username: row.username,
    ki: row.ki,
    games: row.games,
    discordId: row.discordId,
  }));
}

export async function loadOverallLeaderboardPage(
  page: number,
): Promise<OverallLeaderboardPage> {
  const rows = await loadEligibleOverallRows();
  return paginateOverall(rows, page);
}

export async function loadOverallLeaderboardTop(
  limit: number,
): Promise<OverallLeaderboardEntry[]> {
  const rows = await loadEligibleOverallRows();
  return rows.slice(0, limit);
}

function mapHeroRatings(
  rows: {
    playerId: string;
    mu: number;
    sigma: number;
    matchesPlayed: number;
    player: { username: string };
  }[],
  limit: number,
): HeroLeaderboardEntry[] {
  const sorted = rows
    .filter((row) => row.matchesPlayed > 0)
    .map((row) => ({
      playerId: row.playerId,
      username: row.player.username,
      ki: displayOrdinal(row.mu, row.sigma),
      matchesPlayed: row.matchesPlayed,
    }))
    .sort((a, b) => b.ki - a.ki || a.username.localeCompare(b.username))
    .slice(0, limit);

  return assignSortedRanks(sorted).map((row) => ({
    rank: row.rank,
    playerId: row.playerId,
    username: row.username,
    ki: row.ki,
    matchesPlayed: row.matchesPlayed,
  }));
}

export async function loadHeroLeaderboard(
  heroId: number,
  limit: number,
): Promise<{ heroName: string; entries: HeroLeaderboardEntry[] }> {
  const hero = await prisma.hero.findUnique({ where: { id: heroId } });
  if (!hero) {
    throw new LeaderboardServiceError('Unknown hero.');
  }

  const rows = await prisma.playerHeroRating.findMany({
    where: { heroId, matchesPlayed: { gt: 0 } },
    include: { player: { select: { username: true } } },
  });

  return { heroName: hero.name, entries: mapHeroRatings(rows, limit) };
}

export async function loadAllHeroLeaderboards(): Promise<HeroBoardSlice[]> {
  const heroes = await loadHeroCatalog();
  const slices: HeroBoardSlice[] = [];

  for (const hero of heroes) {
    const rows = await prisma.playerHeroRating.findMany({
      where: { heroId: hero.id, matchesPlayed: { gt: 0 } },
      include: { player: { select: { username: true } } },
    });
    slices.push({
      heroId: hero.id,
      heroName: hero.name,
      entries: mapHeroRatings(rows, HERO_COMPACT_TOP),
    });
  }

  return slices;
}
