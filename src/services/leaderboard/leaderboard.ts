import { loadHeroCatalog } from '../guild/hero-catalog.js';
import { prisma } from '../../lib/prisma.js';
import { applyPendingDecayForPlayers } from '../rating/rating-decay.js';
import { displayOrdinal, isCalibrating } from '../rating/rating-math.js';
import {
  gamesByPlayerFromStats,
  heroStatsFor,
  loadMatchDisplayStats,
  loadMatchDisplayStatsByPlayer,
  winRatePercent,
} from '../rating/rank-reset-display.js';

export const LEADERBOARD_PAGE_SIZE = 10;
export const LIVE_LEADERBOARD_MIN_SIZE = 10;
export const LIVE_LEADERBOARD_MAX_SIZE = 100;
export const LIVE_LEADERBOARD_DEFAULT_SIZE = 10;
export const LIVE_LEADERBOARD_CHUNK_SIZE = 25;
export const HERO_COMPACT_TOP = 3;
export const HERO_SINGLE_TOP = 10;

export class LeaderboardServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaderboardServiceError';
  }
}

/** Validate live board size; throws LeaderboardServiceError if invalid. */
export function assertLiveLeaderboardSize(size: number): number {
  if (
    !Number.isInteger(size) ||
    size < LIVE_LEADERBOARD_MIN_SIZE ||
    size > LIVE_LEADERBOARD_MAX_SIZE
  ) {
    throw new LeaderboardServiceError('Live leaderboard size must be between 10 and 100.');
  }
  return size;
}

/** Split entries into fixed-size chunks (default 25). Empty input → []. */
export function chunkLeaderboardEntries<T>(
  entries: T[],
  chunkSize: number = LIVE_LEADERBOARD_CHUNK_SIZE,
): T[][] {
  if (entries.length === 0) {
    return [];
  }
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new LeaderboardServiceError('Leaderboard chunk size must be a positive integer.');
  }
  const chunks: T[][] = [];
  for (let i = 0; i < entries.length; i += chunkSize) {
    chunks.push(entries.slice(i, i + chunkSize));
  }
  return chunks;
}

export type OverallLeaderboardEntry = {
  rank: number | null;
  playerId: string;
  username: string;
  ki: number;
  games: number;
  leagueGames: number;
  discordId: string | null;
  winRatePercent: number | null;
};

export type HeroLeaderboardEntry = {
  rank: number | null;
  playerId: string;
  username: string;
  ki: number;
  matchesPlayed: number;
  leagueGames: number;
  winRatePercent: number | null;
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
export function assignSortedRanks<T extends { ki: number }>(rows: T[]): (T & { rank: number })[] {
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

/**
 * Calibrated rows first (ki desc, competition rank), then calibrating
 * (league games desc, username; rank null). Slice/paginate after this order.
 */
export function rankLeaderboardRows<T extends { ki: number; username: string }>(
  rows: T[],
  getLeagueGames: (row: T) => number,
): (T & { rank: number | null })[] {
  const calibrated = rows
    .filter((row) => !isCalibrating(getLeagueGames(row)))
    .sort((a, b) => b.ki - a.ki || a.username.localeCompare(b.username));
  const calibrating = rows
    .filter((row) => isCalibrating(getLeagueGames(row)))
    .sort((a, b) => getLeagueGames(b) - getLeagueGames(a) || a.username.localeCompare(b.username));

  return [...assignSortedRanks(calibrated), ...calibrating.map((row) => ({ ...row, rank: null }))];
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

async function loadEligibleOverallRows(leagueId: string): Promise<OverallLeaderboardEntry[]> {
  const ratingIds = await prisma.playerRating.findMany({
    where: { leagueId },
    select: { playerId: true },
  });
  await applyPendingDecayForPlayers(
    leagueId,
    ratingIds.map((row) => row.playerId),
  );

  const [ratings, displayStatsByPlayer] = await Promise.all([
    prisma.playerRating.findMany({
      where: { leagueId },
      include: {
        player: { select: { id: true, username: true, discordId: true } },
      },
    }),
    loadMatchDisplayStatsByPlayer(leagueId),
  ]);

  const gamesByPlayer = gamesByPlayerFromStats(displayStatsByPlayer);

  const mapped = ratings
    .map((row) => {
      const games = gamesByPlayer.get(row.playerId) ?? 0;
      const stats = displayStatsByPlayer.get(row.playerId);
      return {
        playerId: row.playerId,
        username: row.player.username,
        discordId: row.player.discordId,
        ki: displayOrdinal(row.mu, row.sigma, games),
        games,
        leagueGames: games,
        winRatePercent: winRatePercent(stats?.wins ?? 0, stats?.losses ?? 0),
      };
    })
    .filter((row) => row.games >= 1);

  return rankLeaderboardRows(mapped, (row) => row.leagueGames).map((row) => ({
    rank: row.rank,
    playerId: row.playerId,
    username: row.username,
    ki: row.ki,
    games: row.games,
    leagueGames: row.leagueGames,
    discordId: row.discordId,
    winRatePercent: row.winRatePercent,
  }));
}

export async function loadOverallLeaderboardPage(
  leagueId: string,
  page: number,
): Promise<OverallLeaderboardPage> {
  const rows = await loadEligibleOverallRows(leagueId);
  return paginateOverall(rows, page);
}

export async function loadOverallLeaderboardTop(
  leagueId: string,
  limit: number,
): Promise<OverallLeaderboardEntry[]> {
  const rows = await loadEligibleOverallRows(leagueId);
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
  leagueGamesByPlayer: Map<string, number>,
  byHero: Map<string, Map<number, { wins: number; losses: number }>>,
  heroId: number,
  limit: number,
): HeroLeaderboardEntry[] {
  const mapped = rows
    .filter((row) => row.matchesPlayed > 0)
    .map((row) => {
      const heroWl = heroStatsFor(byHero, row.playerId, heroId);
      return {
        playerId: row.playerId,
        username: row.player.username,
        ki: displayOrdinal(row.mu, row.sigma, row.matchesPlayed),
        matchesPlayed: row.matchesPlayed,
        leagueGames: leagueGamesByPlayer.get(row.playerId) ?? 0,
        winRatePercent: winRatePercent(heroWl.wins, heroWl.losses),
      };
    });

  return rankLeaderboardRows(mapped, (row) => row.leagueGames)
    .slice(0, limit)
    .map((row) => ({
      rank: row.rank,
      playerId: row.playerId,
      username: row.username,
      ki: row.ki,
      matchesPlayed: row.matchesPlayed,
      leagueGames: row.leagueGames,
      winRatePercent: row.winRatePercent,
    }));
}

export async function loadHeroLeaderboard(
  leagueId: string,
  heroId: number,
  limit: number,
): Promise<{ heroName: string; entries: HeroLeaderboardEntry[] }> {
  const hero = await prisma.hero.findUnique({ where: { id: heroId } });
  if (!hero) {
    throw new LeaderboardServiceError('Unknown hero.');
  }

  const [rows, displayStats] = await Promise.all([
    prisma.playerHeroRating.findMany({
      where: { leagueId, heroId, matchesPlayed: { gt: 0 } },
      include: { player: { select: { username: true } } },
    }),
    loadMatchDisplayStats(leagueId),
  ]);
  const leagueGamesByPlayer = gamesByPlayerFromStats(displayStats.byPlayer);
  return {
    heroName: hero.name,
    entries: mapHeroRatings(rows, leagueGamesByPlayer, displayStats.byHero, heroId, limit),
  };
}

export async function loadAllHeroLeaderboards(leagueId: string): Promise<HeroBoardSlice[]> {
  const heroes = await loadHeroCatalog();
  const displayStats = await loadMatchDisplayStats(leagueId);
  const leagueGamesByPlayer = gamesByPlayerFromStats(displayStats.byPlayer);
  const slices: HeroBoardSlice[] = [];

  for (const hero of heroes) {
    const rows = await prisma.playerHeroRating.findMany({
      where: { leagueId, heroId: hero.id, matchesPlayed: { gt: 0 } },
      include: { player: { select: { username: true } } },
    });
    slices.push({
      heroId: hero.id,
      heroName: hero.name,
      entries: mapHeroRatings(
        rows,
        leagueGamesByPlayer,
        displayStats.byHero,
        hero.id,
        HERO_COMPACT_TOP,
      ),
    });
  }

  return slices;
}
