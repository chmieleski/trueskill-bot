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

/** Only list partners/opponents with a shared match within this many days (stats still all-time). */
export const COMPANION_RECENCY_DAYS = 14;

/** Min shared games before a pair can appear on Win with / Lose with. */
export const WINRATE_LIST_MIN_GAMES = 5;

export type TeammateSortPrimary = 'games' | 'winRate' | 'loseRate';

/** Compare WR%; nulls always sort last. `direction` is applied only when both are numeric. */
function compareWinRate(aWr: number | null, bWr: number | null, direction: 'desc' | 'asc'): number {
  if (aWr === null && bWr === null) return 0;
  if (aWr === null) return 1;
  if (bWr === null) return -1;
  return direction === 'desc' ? bWr - aWr : aWr - bWr;
}

/** Compare shared-game count; higher first. */
function compareGamesDesc(a: TeammatePairStats, b: TeammatePairStats): number {
  return b.games - a.games;
}

/**
 * Rank pairs by primary metric, then tie-break, then nick A–Z. Cap at `limit` (default 3).
 *
 * - `games`: games desc → WR% desc → nick (no games floor)
 * - `winRate`: WR% desc → shared games desc → nick (≥ {@link WINRATE_LIST_MIN_GAMES} games)
 * - `loseRate`: WR% asc → shared games desc → nick (≥ {@link WINRATE_LIST_MIN_GAMES} games)
 */
export function pickTopTeammates(
  pairs: TeammatePairStats[],
  primary: TeammateSortPrimary,
  limit: number = DEFAULT_TOP,
): TeammatePairStats[] {
  const eligible =
    primary === 'games' ? pairs : pairs.filter((pair) => pair.games >= WINRATE_LIST_MIN_GAMES);

  return [...eligible]
    .sort((a, b) => {
      if (primary === 'games') {
        const gamesDiff = compareGamesDesc(a, b);
        if (gamesDiff !== 0) return gamesDiff;
        const wrDiff = compareWinRate(a.winRatePercent, b.winRatePercent, 'desc');
        if (wrDiff !== 0) return wrDiff;
      } else if (primary === 'winRate') {
        const wrDiff = compareWinRate(a.winRatePercent, b.winRatePercent, 'desc');
        if (wrDiff !== 0) return wrDiff;
        const gamesDiff = compareGamesDesc(a, b);
        if (gamesDiff !== 0) return gamesDiff;
      } else {
        const wrDiff = compareWinRate(a.winRatePercent, b.winRatePercent, 'asc');
        if (wrDiff !== 0) return wrDiff;
        const gamesDiff = compareGamesDesc(a, b);
        if (gamesDiff !== 0) return gamesDiff;
      }
      return a.username.localeCompare(b.username);
    })
    .slice(0, limit);
}

type PairBucket = {
  username: string;
  wins: number;
  losses: number;
  lastPlayedAt: Date | null;
};

function recencyCutoff(recencyDays: number, now: Date): Date {
  return new Date(now.getTime() - recencyDays * 24 * 60 * 60 * 1000);
}

/** Aggregate partner/opponent W/L from eligible rows; hide pairs idle longer than the recency window. */
export function aggregateCompanionPairs(
  rows: TeammateMatchRow[],
  options?: { recencyDays?: number; now?: Date },
): TeammatePairStats[] {
  const recencyDays = options?.recencyDays ?? COMPANION_RECENCY_DAYS;
  const now = options?.now ?? new Date();
  const cutoff = recencyCutoff(recencyDays, now);
  const buckets = new Map<string, PairBucket>();

  for (const row of rows) {
    for (const partner of row.partners) {
      if (partner.playerId === row.viewedPlayerId) continue;
      let bucket = buckets.get(partner.playerId);
      if (!bucket) {
        bucket = { username: partner.username, wins: 0, losses: 0, lastPlayedAt: null };
        buckets.set(partner.playerId, bucket);
      } else {
        bucket.username = partner.username;
      }
      if (row.completedAt && (!bucket.lastPlayedAt || row.completedAt > bucket.lastPlayedAt)) {
        bucket.lastPlayedAt = row.completedAt;
      }
      if (row.viewedResult === 'WIN') bucket.wins += 1;
      else bucket.losses += 1;
    }
  }

  return [...buckets.entries()]
    .filter(([, bucket]) => bucket.lastPlayedAt !== null && bucket.lastPlayedAt >= cutoff)
    .map(([playerId, bucket]) => {
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

/** Aggregate same-team partner W/L from already-eligible match rows. */
export function aggregateTeammatePairs(
  rows: TeammateMatchRow[],
  options?: { recencyDays?: number; now?: Date },
): TeammatePairStats[] {
  return aggregateCompanionPairs(rows, options);
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
    winWith: pickTopTeammates(pairs, 'winRate'),
    loseWith: pickTopTeammates(pairs, 'loseRate'),
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
