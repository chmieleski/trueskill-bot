import type { PrismaClient } from '@dbz/db';
import {
  loadMatchDisplayStatsFromHistory,
  type PlayerMatchDisplayStats,
} from './rank-reset-display.js';

export type DisplayCounterColumns = {
  displayWins: number;
  displayLosses: number;
  displayQuits: number;
  displayGriefs: number;
  displayDcs: number;
};

export function displayStatsFromCounters(row: DisplayCounterColumns): PlayerMatchDisplayStats {
  return {
    wins: row.displayWins,
    losses: row.displayLosses,
    games: row.displayWins + row.displayLosses,
    quits: row.displayQuits,
    griefs: row.displayGriefs,
    dcs: row.displayDcs,
  };
}

export function countersEqualStats(
  a: PlayerMatchDisplayStats,
  b: PlayerMatchDisplayStats,
): boolean {
  return (
    a.wins === b.wins &&
    a.losses === b.losses &&
    a.quits === b.quits &&
    a.griefs === b.griefs &&
    a.dcs === b.dcs
  );
}

export function counterColumnsFromStats(stats: PlayerMatchDisplayStats): DisplayCounterColumns {
  return {
    displayWins: stats.wins,
    displayLosses: stats.losses,
    displayQuits: stats.quits,
    displayGriefs: stats.griefs,
    displayDcs: stats.dcs,
  };
}

type Db = Pick<PrismaClient, 'playerRating' | 'playerRankReset' | 'matchPlayer'>;

/** Recompute from MatchPlayer history and persist (rank reset / backfill / repair). */
export async function recomputeDisplayCountersForPlayer(
  leagueId: string,
  playerId: string,
  db: Db,
): Promise<PlayerMatchDisplayStats> {
  const map = await loadMatchDisplayStatsFromHistory(leagueId, [playerId], db);
  const stats = map.get(playerId) ?? {
    games: 0,
    wins: 0,
    losses: 0,
    quits: 0,
    griefs: 0,
    dcs: 0,
  };
  await db.playerRating.update({
    where: { leagueId_playerId: { leagueId, playerId } },
    data: counterColumnsFromStats(stats),
  });
  return stats;
}
