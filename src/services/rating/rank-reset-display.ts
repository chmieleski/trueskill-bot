import { MatchResult, MatchStatus, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../lib/prisma.js';

export type MatchDisplayStatRow = {
  playerId: string;
  result: MatchResult | null;
  isQuitter: boolean;
  completedAt: Date | null;
};

export type PlayerMatchDisplayStats = {
  games: number;
  wins: number;
  losses: number;
  quits: number;
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

/** Aggregate W/L/games/quits, applying each player's latest rank-reset cutoff. */
export function aggregateMatchDisplayStats(
  rows: MatchDisplayStatRow[],
  resetAtByPlayer: Map<string, Date>,
): Map<string, PlayerMatchDisplayStats> {
  const stats = new Map<string, PlayerMatchDisplayStats>();

  const ensure = (playerId: string): PlayerMatchDisplayStats => {
    let row = stats.get(playerId);
    if (!row) {
      row = { games: 0, wins: 0, losses: 0, quits: 0 };
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
export async function loadMatchDisplayStatsByPlayer(
  leagueId: string,
  playerIds?: string[],
  db: Db = defaultPrisma,
): Promise<Map<string, PlayerMatchDisplayStats>> {
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
        ],
      },
      select: {
        playerId: true,
        result: true,
        isQuitter: true,
        match: { select: { completedAt: true } },
      },
    }),
  ]);

  const rows: MatchDisplayStatRow[] = matchRows.map((row) => ({
    playerId: row.playerId,
    result: row.result,
    isQuitter: row.isQuitter,
    completedAt: row.match.completedAt,
  }));

  return aggregateMatchDisplayStats(rows, resetAtByPlayer);
}
