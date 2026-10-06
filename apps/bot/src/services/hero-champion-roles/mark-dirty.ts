import type { Prisma } from '@dbz/db';
import { prisma } from '../../lib/prisma.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('hero_champion_roles_dirty');

/**
 * Mark a league's hero champion and leaderboard rank roles dirty when a rating-affecting action occurs.
 * Best-effort; accepts an optional transaction client.
 */
export async function markLeagueHeroChampionRolesDirty(
  leagueId: string,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const db = tx ?? prisma;
  if (!db?.league?.update) {
    return;
  }
  try {
    await db.league.update({
      where: { id: leagueId },
      data: { heroChampionRolesDirty: true, rankRolesDirty: true },
    });
    log.debug({ leagueId }, 'Marked hero champion roles dirty');
  } catch (error) {
    log.warn({ err: error, leagueId }, 'Failed to mark hero champion roles dirty');
  }
}
