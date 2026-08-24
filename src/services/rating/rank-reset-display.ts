import { MatchResult, MatchStatus, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../lib/prisma.js';
import { sumGrieferKiTaxByPlayer } from './griefer-tax.js';

export type MatchDisplayStatRow = {
  playerId: string;
  result: MatchResult | null;
  isQuitter: boolean;
  isGriefer: boolean;
  completedAt: Date | null;
  heroId?: number | null;
};

/** Row shape for point-in-time completed-game counts (e.g. match history). */
export type CompletedGamesCountRow = {
  playerId: string;
  result: MatchResult | null;
  completedAt: Date | null;
};

export type PlayerMatchDisplayStats = {
  games: number;
  wins: number;
  losses: number;
  quits: number;
  griefs: number;
};

export type PlayerHeroMatchDisplayStats = {
  wins: number;
  losses: number;
};

export type MatchDisplayStatsBundle = {
  byPlayer: Map<string, PlayerMatchDisplayStats>;
  byHero: Map<string, Map<number, PlayerHeroMatchDisplayStats>>;
};

type Db = Pick<PrismaClient, 'playerRankReset' | 'matchPlayer'>;

/**
 * Whether a completed match counts toward post-reset display stats (ki soft-z, W/L).
 * Lifetime history is used when the player has never reset in the league.
 */
export function isMatchCountedAfterRankReset(
  completedAt: Date | null | undefined,
  resetAt: Date | undefined,
): boolean {
  if (!resetAt) {
    return true;
  }
  if (!completedAt) {
    return false;
  }
  return completedAt.getTime() > resetAt.getTime();
}

/**
 * After-match WIN/LOSS count for one player through a completion timestamp,
 * including every row at or before that time (respecting rank-reset cutoff).
 */
export function countCompletedGamesThrough(
  matchRows: CompletedGamesCountRow[],
  playerId: string,
  throughCompletedAt: Date,
  resetAt: Date | undefined,
): number {
  let count = 0;
  const throughMs = throughCompletedAt.getTime();

  for (const row of matchRows) {
    if (row.playerId !== playerId) {
      continue;
    }
    if (row.result !== MatchResult.WIN && row.result !== MatchResult.LOSS) {
      continue;
    }
    if (!row.completedAt) {
      continue;
    }
    if (row.completedAt.getTime() > throughMs) {
      continue;
    }
    if (!isMatchCountedAfterRankReset(row.completedAt, resetAt)) {
      continue;
    }
    count += 1;
  }

  return count;
}

/** Aggregate W/L/games/quits, applying each player's latest rank-reset cutoff. */
export function aggregateMatchDisplayStats(
  rows: MatchDisplayStatRow[],
  resetAtByPlayer: Map<string, Date>,
): Map<string, PlayerMatchDisplayStats> {
  const stats = new Map<string, PlayerMatchDisplayStats>();

  const ensure = (playerId: string): PlayerMatchDisplayStats => {
    let row = stats.get(playerId);
    if (!row) {
      row = { games: 0, wins: 0, losses: 0, quits: 0, griefs: 0 };
      stats.set(playerId, row);
    }
    return row;
  };

  for (const row of rows) {
    const resetAt = resetAtByPlayer.get(row.playerId);
    if (!isMatchCountedAfterRankReset(row.completedAt, resetAt)) {
      // Still ensure a zeroed entry when we know the player from reset map only.
      continue;
    }

    const bucket = ensure(row.playerId);
    if (row.result === MatchResult.WIN || row.result === MatchResult.LOSS) {
      bucket.games += 1;
      if (row.result === MatchResult.WIN) {
        bucket.wins += 1;
      } else {
        bucket.losses += 1;
      }
    }
    if (row.isQuitter) {
      bucket.quits += 1;
    }
    if (row.isGriefer && !row.isQuitter) {
      bucket.griefs += 1;
    }
  }

  for (const playerId of resetAtByPlayer.keys()) {
    ensure(playerId);
  }

  return stats;
}

/** Map playerId → games for displayOrdinal / leaderboard callers. */
export function gamesByPlayerFromStats(
  stats: Map<string, PlayerMatchDisplayStats>,
): Map<string, number> {
  return new Map([...stats.entries()].map(([playerId, row]) => [playerId, row.games]));
}

/** True when league quit rate is 50%+ (same W/L/Q window as `/rank`). */
export function isHabitualQuitter(quits: number, games: number): boolean {
  if (quits < 1) {
    return false;
  }
  if (games === 0) {
    return true;
  }
  return quits / games >= 0.5;
}

/** Look up display stats for one player; missing row is 0/0 (not flagged). */
export function habitualQuitterFromStats(
  stats: Map<string, PlayerMatchDisplayStats>,
  playerId: string,
): boolean {
  const row = stats.get(playerId);
  return isHabitualQuitter(row?.quits ?? 0, row?.games ?? 0);
}

/** Public win rate: one decimal, null when no completed WIN/LOSS. */
export function winRatePercent(wins: number, losses: number): number | null {
  const games = wins + losses;
  if (games === 0) {
    return null;
  }
  return Math.round((wins / games) * 1000) / 10;
}

export function heroStatsFor(
  byHero: Map<string, Map<number, PlayerHeroMatchDisplayStats>>,
  playerId: string,
  heroId: number,
): PlayerHeroMatchDisplayStats {
  return byHero.get(playerId)?.get(heroId) ?? { wins: 0, losses: 0 };
}

/** Aggregate per-hero W/L, applying each player's latest rank-reset cutoff. */
export function aggregateHeroMatchDisplayStats(
  rows: MatchDisplayStatRow[],
  resetAtByPlayer: Map<string, Date>,
): Map<string, Map<number, PlayerHeroMatchDisplayStats>> {
  const stats = new Map<string, Map<number, PlayerHeroMatchDisplayStats>>();

  for (const row of rows) {
    if (row.heroId == null) {
      continue;
    }
    if (row.result !== MatchResult.WIN && row.result !== MatchResult.LOSS) {
      continue;
    }
    const resetAt = resetAtByPlayer.get(row.playerId);
    if (!isMatchCountedAfterRankReset(row.completedAt, resetAt)) {
      continue;
    }

    let byHero = stats.get(row.playerId);
    if (!byHero) {
      byHero = new Map();
      stats.set(row.playerId, byHero);
    }
    let bucket = byHero.get(row.heroId);
    if (!bucket) {
      bucket = { wins: 0, losses: 0 };
      byHero.set(row.heroId, bucket);
    }
    if (row.result === MatchResult.WIN) {
      bucket.wins += 1;
    } else {
      bucket.losses += 1;
    }
  }

  return stats;
}

/** Latest PlayerRankReset.createdAt per player in a league. */
export async function loadLatestRankResetAtByPlayer(
  leagueId: string,
  playerIds?: string[],
  db: Db = defaultPrisma,
): Promise<Map<string, Date>> {
  const rows = await db.playerRankReset.findMany({
    where: {
      leagueId,
      ...(playerIds ? { playerId: { in: playerIds } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    distinct: ['playerId'],
    select: { playerId: true, createdAt: true },
  });
  return new Map(rows.map((row) => [row.playerId, row.createdAt]));
}

/**
 * Load completed W/L (+ quitter flags) for a league, scoped to optional playerIds,
 * then apply rank-reset cutoffs for public display stats.
 */
async function loadMatchDisplayRows(
  leagueId: string,
  playerIds: string[] | undefined,
  db: Db,
): Promise<{
  resetAtByPlayer: Map<string, Date>;
  rows: MatchDisplayStatRow[];
}> {
  const [resetAtByPlayer, matchRows] = await Promise.all([
    loadLatestRankResetAtByPlayer(leagueId, playerIds, db),
    db.matchPlayer.findMany({
      where: {
        ...(playerIds ? { playerId: { in: playerIds } } : {}),
        OR: [
          {
            match: { leagueId, status: MatchStatus.COMPLETED },
            result: { in: [MatchResult.WIN, MatchResult.LOSS] },
          },
          {
            isQuitter: true,
            match: {
              leagueId,
              status: { in: [MatchStatus.COMPLETED, MatchStatus.CANCELLED] },
            },
          },
          {
            isGriefer: true,
            isQuitter: false,
            match: {
              leagueId,
              status: { in: [MatchStatus.COMPLETED, MatchStatus.CANCELLED] },
            },
          },
        ],
      },
      select: {
        playerId: true,
        heroId: true,
        result: true,
        isQuitter: true,
        isGriefer: true,
        match: { select: { completedAt: true } },
      },
    }),
  ]);

  const rows: MatchDisplayStatRow[] = matchRows.map((row) => ({
    playerId: row.playerId,
    heroId: row.heroId,
    result: row.result,
    isQuitter: row.isQuitter,
    isGriefer: row.isGriefer,
    completedAt: row.match.completedAt,
  }));

  return { resetAtByPlayer, rows };
}

export async function loadMatchDisplayStats(
  leagueId: string,
  playerIds?: string[],
  db: Db = defaultPrisma,
): Promise<MatchDisplayStatsBundle> {
  const { resetAtByPlayer, rows } = await loadMatchDisplayRows(leagueId, playerIds, db);
  return {
    byPlayer: aggregateMatchDisplayStats(rows, resetAtByPlayer),
    byHero: aggregateHeroMatchDisplayStats(rows, resetAtByPlayer),
  };
}

export async function loadMatchDisplayStatsByPlayer(
  leagueId: string,
  playerIds?: string[],
  db: Db = defaultPrisma,
): Promise<Map<string, PlayerMatchDisplayStats>> {
  const { resetAtByPlayer, rows } = await loadMatchDisplayRows(leagueId, playerIds, db);
  return aggregateMatchDisplayStats(rows, resetAtByPlayer);
}

/** Sum deferred griefer ki tax per player in one league (active season accruals). */
export async function loadPendingGrieferKiTaxByPlayer(
  leagueId: string,
  playerIds?: string[],
  db: Db = defaultPrisma,
): Promise<Map<string, number>> {
  const rows = await db.matchPlayer.findMany({
    where: {
      isGriefer: true,
      isQuitter: false,
      grieferKiAccrued: { not: null },
      match: { leagueId },
      ...(playerIds ? { playerId: { in: playerIds } } : {}),
    },
    select: { playerId: true, grieferKiAccrued: true },
  });
  return sumGrieferKiTaxByPlayer(rows);
}
