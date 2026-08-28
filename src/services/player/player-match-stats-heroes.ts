import { MatchResult, MatchStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  isMatchCountedAfterRankReset,
  loadLatestRankResetAtByPlayer,
  winRatePercent,
} from '../rating/rank-reset-display.js';
import { RANK_HERO_TOP, sortRankProfileHeroes, type PlayerProfileHero } from './player-profile.js';

export type MatchStatsHeroRow = {
  heroName: string;
  heroObjectId: number | null;
  result: 'WIN' | 'LOSS';
  completedAt: Date | null;
};

type HeroBucket = {
  displayName: string;
  heroObjectId: number | null;
  wins: number;
  losses: number;
};

function normalizeHeroKey(heroName: string): string {
  return heroName.trim().toLowerCase();
}

function heroIdFromKey(key: string): number {
  let hash = 0;
  for (const char of key) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) || 1;
}

/**
 * Aggregate per-hero W/L from completed matches with uploaded stats (WOS bot reports).
 * Applies the player's rank-reset cutoff; skips rows without a hero name.
 */
export function aggregateRankHeroesFromMatchRows(
  rows: MatchStatsHeroRow[],
  resetAt: Date | undefined,
): PlayerProfileHero[] {
  const buckets = new Map<string, HeroBucket>();

  for (const row of rows) {
    const heroName = row.heroName.trim();
    if (!heroName) {
      continue;
    }
    if (!isMatchCountedAfterRankReset(row.completedAt, resetAt)) {
      continue;
    }

    const key = normalizeHeroKey(heroName);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        displayName: heroName,
        heroObjectId: row.heroObjectId,
        wins: 0,
        losses: 0,
      };
      buckets.set(key, bucket);
    } else if (bucket.heroObjectId == null && row.heroObjectId != null) {
      bucket.heroObjectId = row.heroObjectId;
    }

    if (row.result === MatchResult.WIN) {
      bucket.wins += 1;
    } else {
      bucket.losses += 1;
    }
  }

  const heroes = [...buckets.entries()].map(([key, bucket]) => {
    const matchesPlayed = bucket.wins + bucket.losses;
    return {
      heroId: bucket.heroObjectId ?? heroIdFromKey(key),
      name: bucket.displayName,
      ki: 0,
      leadingColumn: `${matchesPlayed}G`,
      matchesPlayed,
      wins: bucket.wins,
      losses: bucket.losses,
      winRatePercent: winRatePercent(bucket.wins, bucket.losses),
    };
  });

  return sortRankProfileHeroes(heroes);
}

/** Load top {@link RANK_HERO_TOP} heroes for `/rank` from persisted match stats. */
export async function loadRankHeroesFromMatchStats(
  leagueId: string,
  playerId: string,
): Promise<PlayerProfileHero[]> {
  const [resetAtByPlayer, rows] = await Promise.all([
    loadLatestRankResetAtByPlayer(leagueId, [playerId]),
    prisma.matchPlayer.findMany({
      where: {
        playerId,
        result: { in: [MatchResult.WIN, MatchResult.LOSS] },
        match: { leagueId, status: MatchStatus.COMPLETED },
        stats: { heroName: { not: null } },
      },
      select: {
        result: true,
        match: { select: { completedAt: true } },
        stats: { select: { heroName: true, heroObjectId: true } },
      },
    }),
  ]);

  const resetAt = resetAtByPlayer.get(playerId);
  const heroRows: MatchStatsHeroRow[] = [];

  for (const row of rows) {
    if (row.result !== MatchResult.WIN && row.result !== MatchResult.LOSS) {
      continue;
    }
    const heroName = row.stats?.heroName?.trim();
    if (!heroName) {
      continue;
    }
    heroRows.push({
      heroName,
      heroObjectId: row.stats?.heroObjectId ?? null,
      result: row.result,
      completedAt: row.match.completedAt,
    });
  }

  return aggregateRankHeroesFromMatchRows(heroRows, resetAt);
}
