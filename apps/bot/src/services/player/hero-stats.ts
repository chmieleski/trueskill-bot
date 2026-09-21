import { MatchResult, MatchStatus } from '@dbz/db';
import { prisma } from '../../lib/prisma.js';
import {
  resolveHeroSelection,
  statsRowMatchesHeroSelection,
  formatHeroDisplayName,
  resolveHeroDisplayNames,
  type HeroSelection,
} from '../game/game-hero-catalog.js';
import { clampMatchHistoryPage } from '../match/match-history.js';
import {
  isMatchCountedAfterRankReset,
  loadLatestRankResetAtByPlayer,
  winRatePercent,
} from '../rating/rank-reset-display.js';

export type StatsWindow = 'last20' | 'overall';

/** Recent-match window size for `/hero`, `/hero_players`, and `/items`. */
export const STATS_RECENT_MATCH_COUNT = 20;

/** Parse the optional `window` slash option into concrete windows. */
export function parseStatsWindows(raw: string | null): StatsWindow[] {
  if (raw === 'last20') {
    return ['last20'];
  }
  if (raw === 'overall') {
    return ['overall'];
  }
  return ['last20', 'overall'];
}

export type HeroStatsRow = {
  matchId: string;
  playerId: string;
  username: string;
  result: typeof MatchResult.WIN | typeof MatchResult.LOSS;
  completedAt: Date | null;
  damageTotal: number;
  takenTotal: number;
  heal: number;
  kills: number;
  deaths: number;
};

export type HeroTopPlayer = {
  username: string;
  games: number;
  wins: number;
  losses: number;
  winRatePercent: number;
};

export type HeroWindowStats = {
  games: number;
  avgDamage: number;
  avgTaken: number;
  avgHeal: number;
  kda: string;
  topPlayers: HeroTopPlayer[];
};

export type HeroRecentGame = {
  matchId: string;
  username: string;
  result: typeof MatchResult.WIN | typeof MatchResult.LOSS;
  completedAt: Date | null;
};

export type HeroPlayerSort = 'win_rate' | 'games' | 'damage' | 'kda';

export type HeroRankedPlayer = HeroTopPlayer & {
  avgDamage: number;
  kda: string;
};

export type HeroStatsResult = {
  heroDisplayName: string;
  windows: Partial<Record<StatsWindow, HeroWindowStats>>;
  recentGames: HeroRecentGame[];
  playerUsername?: string;
  rankResetAt?: Date;
};

export type HeroPlayersResult = {
  heroDisplayName: string;
  sort: HeroPlayerSort;
  windows: Partial<Record<StatsWindow, HeroRankedPlayer[]>>;
};

export type HeroAllStatsWindow = 'last20' | 'overall';

export type HeroAllSort = 'win_rate' | 'games' | 'damage' | 'taken' | 'heal';

export type HeroAllEntry = {
  heroDisplayName: string;
  games: number;
  wins: number;
  losses: number;
  winRatePercent: number;
  avgDamage: number;
  avgTaken: number;
  avgHeal: number;
};

export type HeroAllRankingsResult = {
  sort: HeroAllSort;
  page: number;
  totalPages: number;
  totalHeroes: number;
  windows: Partial<Record<HeroAllStatsWindow, HeroAllEntry[]>>;
};

export const HERO_ALL_PAGE_SIZE = 15;

export type HeroAllStatsRow = HeroStatsRow & {
  heroDisplayName: string;
  heroNameKey: string;
};

/** Parse the optional `window` slash option for `/hero_all`. */
export function parseHeroAllStatsWindows(raw: string | null): HeroAllStatsWindow[] {
  if (raw === 'last20') {
    return ['last20'];
  }
  if (raw === 'overall') {
    return ['overall'];
  }
  return ['last20', 'overall'];
}

const TOP_PLAYERS_LIMIT = 5;
const TOP_PLAYERS_MIN_GAMES = 3;

/** Case-insensitive hero name key for matching report picks. */
export function normalizeHeroNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Keep rows from the N most recent distinct matches in the set. */
export function filterRowsToLastNMatches<T extends Pick<HeroStatsRow, 'matchId' | 'completedAt'>>(
  rows: T[],
  matchCount: number,
): T[] {
  const matchCompletedAt = new Map<string, number>();
  for (const row of rows) {
    const ms = row.completedAt?.getTime() ?? 0;
    const existing = matchCompletedAt.get(row.matchId);
    if (existing === undefined || ms > existing) {
      matchCompletedAt.set(row.matchId, ms);
    }
  }

  const lastMatchIds = new Set(
    [...matchCompletedAt.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, matchCount)
      .map(([matchId]) => matchId),
  );

  return rows.filter((row) => lastMatchIds.has(row.matchId));
}

/** Keep rows from the recent-stats window of distinct matches in the set. */
export function filterRowsToLast20Matches(rows: HeroStatsRow[]): HeroStatsRow[] {
  return filterRowsToLastNMatches(rows, STATS_RECENT_MATCH_COUNT);
}

function formatKda(kills: number, deaths: number): string {
  if (deaths === 0) {
    return '—';
  }
  return String(Math.round((kills / deaths) * 10) / 10);
}

/** Newest player-game rows up to `limit`. */
export function pickRecentHeroGames(rows: HeroStatsRow[], limit: number): HeroRecentGame[] {
  return [...rows]
    .sort(
      (left, right) =>
        (right.completedAt?.getTime() ?? 0) - (left.completedAt?.getTime() ?? 0) ||
        right.matchId.localeCompare(left.matchId),
    )
    .slice(0, limit)
    .map((entry) => ({
      matchId: entry.matchId,
      username: entry.username,
      result: entry.result,
      completedAt: entry.completedAt,
    }));
}

type PlayerBucket = {
  username: string;
  wins: number;
  losses: number;
  damageTotal: number;
  kills: number;
  deaths: number;
};

function bucketPlayers(rows: HeroStatsRow[]): Map<string, PlayerBucket> {
  const buckets = new Map<string, PlayerBucket>();
  for (const row of rows) {
    let bucket = buckets.get(row.playerId);
    if (!bucket) {
      bucket = { username: row.username, wins: 0, losses: 0, damageTotal: 0, kills: 0, deaths: 0 };
      buckets.set(row.playerId, bucket);
    }
    if (row.result === MatchResult.WIN) {
      bucket.wins += 1;
    } else {
      bucket.losses += 1;
    }
    bucket.damageTotal += row.damageTotal;
    bucket.kills += row.kills;
    bucket.deaths += row.deaths;
  }
  return buckets;
}

function compareUsernames(left: HeroRankedPlayer, right: HeroRankedPlayer): number {
  return left.username.localeCompare(right.username);
}

/** Rank players on a hero for one stats window. */
export function rankHeroPlayers(
  rows: HeroStatsRow[],
  sort: HeroPlayerSort,
  limit: number,
): HeroRankedPlayer[] {
  const players = [...bucketPlayers(rows).entries()]
    .map(([, bucket]) => {
      const games = bucket.wins + bucket.losses;
      return {
        username: bucket.username,
        games,
        wins: bucket.wins,
        losses: bucket.losses,
        winRatePercent: winRatePercent(bucket.wins, bucket.losses) ?? 0,
        avgDamage: Math.round(bucket.damageTotal / games),
        kda: formatKda(bucket.kills, bucket.deaths),
      };
    })
    .filter((entry) => entry.games >= TOP_PLAYERS_MIN_GAMES);

  players.sort((left, right) => {
    switch (sort) {
      case 'games':
        return (
          right.games - left.games ||
          right.winRatePercent - left.winRatePercent ||
          compareUsernames(left, right)
        );
      case 'damage':
        return (
          right.avgDamage - left.avgDamage ||
          right.games - left.games ||
          compareUsernames(left, right)
        );
      case 'kda': {
        const leftKda = left.kda === '—' ? -1 : Number(left.kda);
        const rightKda = right.kda === '—' ? -1 : Number(right.kda);
        return rightKda - leftKda || right.games - left.games || compareUsernames(left, right);
      }
      case 'win_rate':
      default:
        return (
          right.winRatePercent - left.winRatePercent ||
          right.games - left.games ||
          compareUsernames(left, right)
        );
    }
  });

  return players.slice(0, limit);
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Aggregate combat averages and optional top players for one window of rows. */
export function aggregateHeroWindowStats(
  rows: HeroStatsRow[],
  options: { includeTopPlayers: boolean },
): HeroWindowStats {
  const games = rows.length;
  const totalKills = rows.reduce((sum, row) => sum + row.kills, 0);
  const totalDeaths = rows.reduce((sum, row) => sum + row.deaths, 0);

  const topPlayers: HeroTopPlayer[] = options.includeTopPlayers
    ? rankHeroPlayers(rows, 'win_rate', TOP_PLAYERS_LIMIT).map(
        ({ username, games, wins, losses, winRatePercent }) => ({
          username,
          games,
          wins,
          losses,
          winRatePercent,
        }),
      )
    : [];

  return {
    games,
    avgDamage: Math.round(mean(rows.map((row) => row.damageTotal))),
    avgTaken: Math.round(mean(rows.map((row) => row.takenTotal))),
    avgHeal: Math.round(mean(rows.map((row) => row.heal))),
    kda: formatKda(totalKills, totalDeaths),
    topPlayers,
  };
}

function mapPrismaRows(
  rows: Array<{
    playerId: string;
    result: MatchResult | null;
    matchId: string;
    player: { username: string };
    match: { completedAt: Date | null };
    stats: {
      heroName: string | null;
      heroObjectId: number | null;
      damageTotal: number;
      takenTotal: number;
      heal: number;
      kills: number;
      deaths: number;
    } | null;
  }>,
  selection: HeroSelection,
  resetAt: Date | undefined,
): HeroStatsRow[] {
  const mapped: HeroStatsRow[] = [];

  for (const row of rows) {
    if (row.result !== MatchResult.WIN && row.result !== MatchResult.LOSS) {
      continue;
    }
    const stats = row.stats;
    if (!stats || !statsRowMatchesHeroSelection(stats, selection)) {
      continue;
    }
    if (resetAt !== undefined && !isMatchCountedAfterRankReset(row.match.completedAt, resetAt)) {
      continue;
    }

    mapped.push({
      matchId: row.matchId,
      playerId: row.playerId,
      username: row.player.username,
      result: row.result,
      completedAt: row.match.completedAt,
      damageTotal: stats.damageTotal,
      takenTotal: stats.takenTotal,
      heal: stats.heal,
      kills: stats.kills,
      deaths: stats.deaths,
    });
  }

  return mapped;
}

async function loadHeroStatsRowsForSelection(input: {
  leagueId: string;
  selection: HeroSelection;
  playerId?: string;
}): Promise<{ allRows: HeroStatsRow[]; resetAt?: Date }> {
  const resetAtByPlayer =
    input.playerId !== undefined
      ? await loadLatestRankResetAtByPlayer(input.leagueId, [input.playerId])
      : new Map<string, Date>();
  const resetAt = input.playerId ? resetAtByPlayer.get(input.playerId) : undefined;

  const rows = await prisma.matchPlayer.findMany({
    where: {
      ...(input.playerId ? { playerId: input.playerId } : {}),
      result: { in: [MatchResult.WIN, MatchResult.LOSS] },
      match: { leagueId: input.leagueId, status: MatchStatus.COMPLETED },
      stats: { heroName: { not: null } },
    },
    select: {
      playerId: true,
      result: true,
      matchId: true,
      player: { select: { username: true } },
      match: { select: { completedAt: true } },
      stats: {
        select: {
          heroName: true,
          heroObjectId: true,
          damageTotal: true,
          takenTotal: true,
          heal: true,
          kills: true,
          deaths: true,
        },
      },
    },
  });

  return { allRows: mapPrismaRows(rows, input.selection, resetAt), resetAt };
}

async function loadHeroStatsRows(input: {
  leagueId: string;
  gameId: string;
  heroName: string;
  playerId?: string;
}): Promise<{ selection: HeroSelection; allRows: HeroStatsRow[]; resetAt?: Date } | null> {
  const selection = await resolveHeroSelection(input.gameId, input.leagueId, input.heroName);
  if (!selection) {
    return null;
  }

  const { allRows, resetAt } = await loadHeroStatsRowsForSelection({
    leagueId: input.leagueId,
    selection,
    playerId: input.playerId,
  });
  if (allRows.length === 0) {
    return null;
  }

  return { selection, allRows, resetAt };
}

/** Load all completed player-game rows for one hero (empty array when none). */
export async function loadHeroGameRowsBySelection(input: {
  leagueId: string;
  selection: HeroSelection;
  playerId: string;
}): Promise<{ rows: HeroStatsRow[]; resetAt?: Date }> {
  const { allRows, resetAt } = await loadHeroStatsRowsForSelection(input);
  return { rows: allRows, resetAt };
}

/** Load hero stats for a league, optionally scoped to one player. */
export async function loadHeroStats(input: {
  leagueId: string;
  gameId: string;
  heroName: string;
  playerId?: string;
  windows: StatsWindow[];
  recentLimit: number;
}): Promise<HeroStatsResult | null> {
  const loaded = await loadHeroStatsRows(input);
  if (!loaded) {
    return null;
  }

  const { selection, allRows, resetAt } = loaded;
  const windows: Partial<Record<StatsWindow, HeroWindowStats>> = {};
  const includeTopPlayers = input.playerId === undefined;

  if (input.windows.includes('overall')) {
    windows.overall = aggregateHeroWindowStats(allRows, { includeTopPlayers });
  }
  if (input.windows.includes('last20')) {
    windows.last20 = aggregateHeroWindowStats(filterRowsToLast20Matches(allRows), {
      includeTopPlayers,
    });
  }

  return {
    heroDisplayName: selection.displayName,
    windows,
    recentGames: pickRecentHeroGames(allRows, input.recentLimit),
    playerUsername: input.playerId ? allRows[0]!.username : undefined,
    rankResetAt: resetAt,
  };
}

/** Load sortable top-player rankings for one hero (league-wide). */
export async function loadHeroPlayerRankings(input: {
  leagueId: string;
  gameId: string;
  heroName: string;
  sort: HeroPlayerSort;
  limit: number;
  windows: StatsWindow[];
}): Promise<HeroPlayersResult | null> {
  const loaded = await loadHeroStatsRows({
    leagueId: input.leagueId,
    gameId: input.gameId,
    heroName: input.heroName,
  });
  if (!loaded) {
    return null;
  }

  const { selection, allRows } = loaded;
  const windows: Partial<Record<StatsWindow, HeroRankedPlayer[]>> = {};

  if (input.windows.includes('overall')) {
    windows.overall = rankHeroPlayers(allRows, input.sort, input.limit);
  }
  if (input.windows.includes('last20')) {
    windows.last20 = rankHeroPlayers(filterRowsToLast20Matches(allRows), input.sort, input.limit);
  }

  return {
    heroDisplayName: selection.displayName,
    sort: input.sort,
    windows,
  };
}

/** Bucket league-wide rows by hero display name key. */
export function bucketRowsByHero(rows: HeroAllStatsRow[]): Map<string, HeroAllStatsRow[]> {
  const buckets = new Map<string, HeroAllStatsRow[]>();
  for (const row of rows) {
    const bucket = buckets.get(row.heroNameKey);
    if (bucket) {
      bucket.push(row);
    } else {
      buckets.set(row.heroNameKey, [row]);
    }
  }
  return buckets;
}

/** Aggregate combat stats for one hero's player-game rows. */
export function aggregateHeroAllEntry(
  heroDisplayName: string,
  rows: HeroStatsRow[],
): HeroAllEntry | null {
  if (rows.length === 0) {
    return null;
  }

  let wins = 0;
  let losses = 0;
  for (const row of rows) {
    if (row.result === MatchResult.WIN) {
      wins += 1;
    } else {
      losses += 1;
    }
  }

  const games = wins + losses;
  return {
    heroDisplayName,
    games,
    wins,
    losses,
    winRatePercent: winRatePercent(wins, losses) ?? 0,
    avgDamage: Math.round(mean(rows.map((entry) => entry.damageTotal))),
    avgTaken: Math.round(mean(rows.map((entry) => entry.takenTotal))),
    avgHeal: Math.round(mean(rows.map((entry) => entry.heal))),
  };
}

function compareHeroDisplayNames(left: HeroAllEntry, right: HeroAllEntry): number {
  return left.heroDisplayName.localeCompare(right.heroDisplayName);
}

/** Rank heroes for one stats window. */
export function rankAllHeroes(entries: HeroAllEntry[], sort: HeroAllSort): HeroAllEntry[] {
  const ranked = [...entries];
  ranked.sort((left, right) => {
    switch (sort) {
      case 'games':
        return (
          right.games - left.games ||
          right.winRatePercent - left.winRatePercent ||
          compareHeroDisplayNames(left, right)
        );
      case 'damage':
        return (
          right.avgDamage - left.avgDamage ||
          right.games - left.games ||
          compareHeroDisplayNames(left, right)
        );
      case 'taken':
        return (
          right.avgTaken - left.avgTaken ||
          right.games - left.games ||
          compareHeroDisplayNames(left, right)
        );
      case 'heal':
        return (
          right.avgHeal - left.avgHeal ||
          right.games - left.games ||
          compareHeroDisplayNames(left, right)
        );
      case 'win_rate':
      default:
        return (
          right.winRatePercent - left.winRatePercent ||
          right.games - left.games ||
          compareHeroDisplayNames(left, right)
        );
    }
  });
  return ranked;
}

function aggregateAllHeroEntries(rows: HeroAllStatsRow[]): HeroAllEntry[] {
  const entries: HeroAllEntry[] = [];
  for (const [, heroRows] of bucketRowsByHero(rows)) {
    const entry = aggregateHeroAllEntry(heroRows[0]!.heroDisplayName, heroRows);
    if (entry && entry.games >= 1) {
      entries.push(entry);
    }
  }
  return entries;
}

function paginateHeroAllEntries(
  entries: HeroAllEntry[],
  page: number,
): { page: number; totalPages: number; totalHeroes: number; entries: HeroAllEntry[] } {
  const totalHeroes = entries.length;
  const totalPages = Math.max(1, Math.ceil(totalHeroes / HERO_ALL_PAGE_SIZE));
  const safePage = clampMatchHistoryPage(page, totalPages);
  const start = (safePage - 1) * HERO_ALL_PAGE_SIZE;
  return {
    page: safePage,
    totalPages,
    totalHeroes,
    entries: entries.slice(start, start + HERO_ALL_PAGE_SIZE),
  };
}

async function loadLeagueHeroAllRows(input: {
  leagueId: string;
  gameId: string;
}): Promise<HeroAllStatsRow[]> {
  const rows = await prisma.matchPlayer.findMany({
    where: {
      result: { in: [MatchResult.WIN, MatchResult.LOSS] },
      match: { leagueId: input.leagueId, status: MatchStatus.COMPLETED },
      stats: { heroName: { not: null } },
    },
    select: {
      playerId: true,
      result: true,
      matchId: true,
      player: { select: { username: true } },
      match: { select: { completedAt: true } },
      stats: {
        select: {
          heroName: true,
          heroObjectId: true,
          damageTotal: true,
          takenTotal: true,
          heal: true,
          kills: true,
          deaths: true,
        },
      },
    },
  });

  const objectIds = new Set<number>();
  for (const row of rows) {
    const objectId = row.stats?.heroObjectId;
    if (objectId != null) {
      objectIds.add(objectId);
    }
  }
  const catalogNames = await resolveHeroDisplayNames(input.gameId, [...objectIds]);

  const mapped: HeroAllStatsRow[] = [];
  for (const row of rows) {
    if (row.result !== MatchResult.WIN && row.result !== MatchResult.LOSS) {
      continue;
    }
    const stats = row.stats;
    if (!stats?.heroName?.trim()) {
      continue;
    }

    const heroDisplayName = formatHeroDisplayName(stats.heroObjectId, catalogNames, stats.heroName);
    mapped.push({
      matchId: row.matchId,
      playerId: row.playerId,
      username: row.player.username,
      result: row.result,
      completedAt: row.match.completedAt,
      damageTotal: stats.damageTotal,
      takenTotal: stats.takenTotal,
      heal: stats.heal,
      kills: stats.kills,
      deaths: stats.deaths,
      heroDisplayName,
      heroNameKey: normalizeHeroNameKey(heroDisplayName),
    });
  }

  return mapped;
}

/** Load sortable, paginated league-wide hero rankings. */
export async function loadAllHeroRankings(input: {
  leagueId: string;
  gameId: string;
  sort: HeroAllSort;
  windows: HeroAllStatsWindow[];
  page: number;
}): Promise<HeroAllRankingsResult> {
  const allRows = await loadLeagueHeroAllRows(input);
  const windowRows: Partial<Record<HeroAllStatsWindow, HeroAllStatsRow[]>> = {};

  if (input.windows.includes('overall')) {
    windowRows.overall = allRows;
  }
  if (input.windows.includes('last20')) {
    windowRows.last20 = filterRowsToLastNMatches(allRows, 20) as HeroAllStatsRow[];
  }

  const windows: Partial<Record<HeroAllStatsWindow, HeroAllEntry[]>> = {};
  let page = 1;
  let totalPages = 1;
  let totalHeroes = 0;

  const metadataWindow: HeroAllStatsWindow = input.windows.includes('overall')
    ? 'overall'
    : (input.windows[0] ?? 'overall');

  for (const window of input.windows) {
    const rows = windowRows[window] ?? [];
    const ranked = rankAllHeroes(aggregateAllHeroEntries(rows), input.sort);
    const paginated = paginateHeroAllEntries(ranked, input.page);
    windows[window] = paginated.entries;
    if (window === metadataWindow) {
      page = paginated.page;
      totalPages = paginated.totalPages;
      totalHeroes = paginated.totalHeroes;
    }
  }

  return {
    sort: input.sort,
    page,
    totalPages,
    totalHeroes,
    windows,
  };
}
