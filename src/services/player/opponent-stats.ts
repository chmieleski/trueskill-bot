import { MatchResult, MatchStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  isMatchCountedAfterRankReset,
  loadLatestRankResetAtByPlayer,
} from '../rating/rank-reset-display.js';
import {
  aggregateCompanionPairs,
  buildTeammateStatsFromPairs,
  type TeammateMatchRow,
  type TeammatePairStats,
} from './teammate-stats.js';

export type OpponentPairStats = TeammatePairStats;

export type OpponentStats = {
  playedAgainst: OpponentPairStats[];
  winAgainst: OpponentPairStats[];
  loseAgainst: OpponentPairStats[];
};

/** Load top-3 opponent lists for a player in a league (post–rank-reset WIN/LOSS only). */
export async function loadOpponentStats(
  leagueId: string,
  playerId: string,
): Promise<OpponentStats> {
  const [resetAtByPlayer, myRows] = await Promise.all([
    loadLatestRankResetAtByPlayer(leagueId, [playerId]),
    prisma.matchPlayer.findMany({
      where: {
        playerId,
        result: { in: [MatchResult.WIN, MatchResult.LOSS] },
        match: { leagueId, status: MatchStatus.COMPLETED },
      },
      select: {
        matchId: true,
        team: true,
        result: true,
        match: {
          select: {
            id: true,
            completedAt: true,
            players: {
              select: {
                playerId: true,
                team: true,
                result: true,
                player: { select: { username: true } },
              },
            },
          },
        },
      },
    }),
  ]);

  const resetAt = resetAtByPlayer.get(playerId);
  const rows: TeammateMatchRow[] = [];

  for (const row of myRows) {
    if (row.result !== MatchResult.WIN && row.result !== MatchResult.LOSS) continue;
    if (!isMatchCountedAfterRankReset(row.match.completedAt, resetAt)) continue;

    const opponents = row.match.players
      .filter((p) => p.playerId !== playerId && p.team !== row.team)
      .map((p) => ({ playerId: p.playerId, username: p.player.username }));

    rows.push({
      matchId: row.match.id,
      completedAt: row.match.completedAt,
      viewedPlayerId: playerId,
      viewedTeam: row.team,
      viewedResult: row.result,
      partners: opponents,
    });
  }

  return buildOpponentStatsFromPairs(aggregateCompanionPairs(rows));
}

/** Build the three top-3 opponent lists from a shared pair pool. */
export function buildOpponentStatsFromPairs(pairs: OpponentPairStats[]): OpponentStats {
  const built = buildTeammateStatsFromPairs(pairs);
  return {
    playedAgainst: built.playedWith,
    winAgainst: built.winWith,
    loseAgainst: built.loseWith,
  };
}
