import { MatchResult, MatchStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  isMatchCountedAfterRankReset,
  loadLatestRankResetAtByPlayer,
  winRatePercent,
} from '../rating/rank-reset-display.js';

export type TeammatePairStats = {
  playerId: string;
  username: string;
  games: number;
  wins: number;
  losses: number;
  winRatePercent: number | null;
};

export type TeammateStats = {
  playedWith: TeammatePairStats[];
  winWith: TeammatePairStats[];
  loseWith: TeammatePairStats[];
};

export type TeammateMatchRow = {
  matchId: string;
  completedAt: Date | null;
  viewedPlayerId: string;
  viewedTeam: number;
  viewedResult: 'WIN' | 'LOSS';
  partners: Array<{ playerId: string; username: string }>;
};

const DEFAULT_TOP = 3;

/** Rank pairs by primary metric, then WR%, then nick A–Z. Cap at `limit` (default 3). */
export function pickTopTeammates(
  pairs: TeammatePairStats[],
  primary: 'games' | 'wins' | 'losses',
  limit: number = DEFAULT_TOP,
): TeammatePairStats[] {
  return [...pairs]
    .sort((a, b) => {
      const primaryDiff = b[primary] - a[primary];
      if (primaryDiff !== 0) return primaryDiff;
      const aWr = a.winRatePercent;
      const bWr = b.winRatePercent;
      if (aWr === null && bWr === null) {
        // fall through
      } else if (aWr === null) {
        return 1;
      } else if (bWr === null) {
        return -1;
      } else if (bWr !== aWr) {
        return bWr - aWr;
      }
      return a.username.localeCompare(b.username);
    })
    .slice(0, limit);
}

/** Aggregate same-team partner W/L from already-eligible match rows. */
export function aggregateTeammatePairs(rows: TeammateMatchRow[]): TeammatePairStats[] {
  const buckets = new Map<string, { username: string; wins: number; losses: number }>();

  for (const row of rows) {
    for (const partner of row.partners) {
      if (partner.playerId === row.viewedPlayerId) continue;
      let bucket = buckets.get(partner.playerId);
      if (!bucket) {
        bucket = { username: partner.username, wins: 0, losses: 0 };
        buckets.set(partner.playerId, bucket);
      } else {
        bucket.username = partner.username;
      }
      if (row.viewedResult === 'WIN') bucket.wins += 1;
      else bucket.losses += 1;
    }
  }

  return [...buckets.entries()].map(([playerId, bucket]) => {
    const games = bucket.wins + bucket.losses;
    return {
      playerId,
      username: bucket.username,
      games,
      wins: bucket.wins,
      losses: bucket.losses,
      winRatePercent: winRatePercent(bucket.wins, bucket.losses),
    };
  });
}

/** Monospace table: `Nick  14G · 9W 5L · 64.3%`. */
export function formatTeammateTable(pairs: TeammatePairStats[]): string {
  if (pairs.length === 0) {
    return '';
  }
  const cells = pairs.map((pair) => {
    const games = `${pair.games}G`;
    const record = `${pair.wins}W ${pair.losses}L`;
    const recordWithWr =
      pair.winRatePercent === null ? record : `${record} · ${pair.winRatePercent}%`;
    return { name: pair.username, games, record: recordWithWr };
  });
  const nameWidth = Math.max(...cells.map((c) => c.name.length));
  const gamesWidth = Math.max(...cells.map((c) => c.games.length));
  const lines = cells.map((cell) => {
    const name = cell.name.padEnd(nameWidth, ' ');
    const games = cell.games.padStart(gamesWidth, ' ');
    return `${name}  ${games} · ${cell.record}`;
  });
  return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

/** Build the three top-3 lists from a shared pair pool. */
export function buildTeammateStatsFromPairs(pairs: TeammatePairStats[]): TeammateStats {
  return {
    playedWith: pickTopTeammates(pairs, 'games'),
    winWith: pickTopTeammates(pairs, 'wins'),
    loseWith: pickTopTeammates(pairs, 'losses'),
  };
}

/** Load top-3 teammate lists for a player in a league (post–rank-reset WIN/LOSS only). */
export async function loadTeammateStats(
  leagueId: string,
  playerId: string,
): Promise<TeammateStats> {
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

    const partners = row.match.players
      .filter((p) => p.playerId !== playerId && p.team === row.team)
      .map((p) => ({ playerId: p.playerId, username: p.player.username }));

    rows.push({
      matchId: row.match.id,
      completedAt: row.match.completedAt,
      viewedPlayerId: playerId,
      viewedTeam: row.team,
      viewedResult: row.result,
      partners,
    });
  }

  return buildTeammateStatsFromPairs(aggregateTeammatePairs(rows));
}
