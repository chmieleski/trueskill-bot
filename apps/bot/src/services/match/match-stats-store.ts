import type { Prisma } from '@dbz/db';
import { prisma } from '../../lib/prisma.js';

/** Remove persisted WOS2 stats for a match (player stats cascade via MatchStatsReport). */
export async function clearMatchStatsReport(
  matchId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  await tx.matchStatsReport.deleteMany({ where: { matchId } });
}

/** Batch variant for stale lobby cleanup. */
export async function clearMatchStatsReports(
  matchIds: string[],
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  if (matchIds.length === 0) {
    return;
  }

  await tx.matchStatsReport.deleteMany({ where: { matchId: { in: matchIds } } });
}
