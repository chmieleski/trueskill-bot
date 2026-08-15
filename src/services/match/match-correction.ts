import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { MatchServiceError } from './match-service.js';

export const CORRECTION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const GLOBAL_SNAPSHOT_HERO_ID = 0;

type Db = Prisma.TransactionClient | typeof prisma;

type SnapshotPlayer = {
  playerId: string;
  heroId: number;
};

/**
 * Persist pre-apply μ/σ (and hero matchesPlayed) for every roster player.
 * Call once before OpenSkill writes on first complete. Idempotent reject if any rows exist.
 */
export async function writeMatchRatingSnapshots(
  leagueId: string,
  matchId: string,
  players: SnapshotPlayer[],
  db: Db = prisma,
): Promise<void> {
  const existing = await db.matchRatingSnapshot.count({ where: { matchId } });
  if (existing > 0) {
    throw new MatchServiceError('Rating snapshots already exist for this match.');
  }

  const playerIds = players.map((p) => p.playerId);
  const [globals, heroes] = await Promise.all([
    db.playerRating.findMany({ where: { leagueId, playerId: { in: playerIds } } }),
    db.playerHeroRating.findMany({
      where: {
        leagueId,
        OR: players.map((p) => ({ playerId: p.playerId, heroId: p.heroId })),
      },
    }),
  ]);

  const globalByPlayer = new Map(globals.map((row) => [row.playerId, row]));
  const heroByKey = new Map(heroes.map((row) => [`${row.playerId}:${row.heroId}`, row]));

  const rows = players.flatMap((player) => {
    const global = globalByPlayer.get(player.playerId);
    const hero = heroByKey.get(`${player.playerId}:${player.heroId}`);
    if (!global || !hero) {
      throw new MatchServiceError(
        'Cannot snapshot ratings: missing player or hero rating rows.',
      );
    }
    return [
      {
        matchId,
        playerId: player.playerId,
        entityKind: 'GLOBAL' as const,
        heroId: GLOBAL_SNAPSHOT_HERO_ID,
        mu: global.mu,
        sigma: global.sigma,
        matchesPlayed: null,
      },
      {
        matchId,
        playerId: player.playerId,
        entityKind: 'HERO' as const,
        heroId: player.heroId,
        mu: hero.mu,
        sigma: hero.sigma,
        matchesPlayed: hero.matchesPlayed,
      },
    ];
  });

  await db.matchRatingSnapshot.createMany({ data: rows });
}

