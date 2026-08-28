import { MatchResult, MatchStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  resolveHeroSelection,
  statsRowMatchesHeroSelection,
  type HeroSelection,
} from '../game/game-hero-catalog.js';
import {
  isMatchCountedAfterRankReset,
  loadLatestRankResetAtByPlayer,
  winRatePercent,
} from '../rating/rank-reset-display.js';

export type StatsWindow = 'last10' | 'overall';

/** Parse the optional `window` slash option into concrete windows. */
export function parseStatsWindows(raw: string | null): StatsWindow[] {
  if (raw === 'last10') {
    return ['last10'];
  }
  if (raw === 'overall') {
    return ['overall'];
  }
  return ['last10', 'overall'];
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

export type HeroStatsResult = {
  heroDisplayName: string;
  windows: Partial<Record<StatsWindow, HeroWindowStats>>;
  playerUsername?: string;
  rankResetAt?: Date;
};

const TOP_PLAYERS_LIMIT = 5;
const TOP_PLAYERS_MIN_GAMES = 3;

/** Case-insensitive hero name key for matching report picks. */
export function normalizeHeroNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Keep rows from the 10 most recent distinct matches in the set. */
export function filterRowsToLast10Matches(rows: HeroStatsRow[]): HeroStatsRow[] {
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

function formatKda(kills: number, deaths: number): string {
  if (deaths === 0) {
    return '—';
  }
  return String(Math.round((kills / deaths) * 10) / 10);
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

  const topPlayers: HeroTopPlayer[] = [];
  if (options.includeTopPlayers) {
    const buckets = new Map<string, { username: string; wins: number; losses: number }>();
    for (const row of rows) {
      let bucket = buckets.get(row.playerId);
      if (!bucket) {
        bucket = { username: row.username, wins: 0, losses: 0 };
        buckets.set(row.playerId, bucket);
      }
      if (row.result === MatchResult.WIN) {
        bucket.wins += 1;
      } else {
        bucket.losses += 1;
      }
    }

    topPlayers.push(
      ...[...buckets.values()]
        .map((bucket) => {
          const playerGames = bucket.wins + bucket.losses;
          return {
            username: bucket.username,
            games: playerGames,
            wins: bucket.wins,
            losses: bucket.losses,
            winRatePercent: winRatePercent(bucket.wins, bucket.losses) ?? 0,
          };
        })
        .filter((entry) => entry.games >= TOP_PLAYERS_MIN_GAMES)
        .sort(
          (left, right) =>
            right.winRatePercent - left.winRatePercent ||
            right.games - left.games ||
            left.username.localeCompare(right.username),
        )
        .slice(0, TOP_PLAYERS_LIMIT),
    );
  }

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

/** Load hero stats for a league, optionally scoped to one player. */
export async function loadHeroStats(input: {
  leagueId: string;
  gameId: string;
  heroName: string;
  playerId?: string;
  windows: StatsWindow[];
}): Promise<HeroStatsResult | null> {
  const selection = await resolveHeroSelection(input.gameId, input.leagueId, input.heroName);
  if (!selection) {
    return null;
  }

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

  const allRows = mapPrismaRows(rows, selection, resetAt);
  if (allRows.length === 0) {
    return null;
  }

  const windows: Partial<Record<StatsWindow, HeroWindowStats>> = {};
  const includeTopPlayers = input.playerId === undefined;

  if (input.windows.includes('overall')) {
    windows.overall = aggregateHeroWindowStats(allRows, { includeTopPlayers });
  }
  if (input.windows.includes('last10')) {
    windows.last10 = aggregateHeroWindowStats(filterRowsToLast10Matches(allRows), {
      includeTopPlayers,
    });
  }

  return {
    heroDisplayName: selection.displayName,
    windows,
    playerUsername: input.playerId ? allRows[0]!.username : undefined,
    rankResetAt: resetAt,
  };
}
