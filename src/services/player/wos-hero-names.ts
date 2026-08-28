import { MatchStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { normalizeHeroNameKey } from './hero-stats.js';

/** Distinct hero names from completed WOS matches in a league (for autocomplete). */
export async function listWosHeroNamesForLeague(leagueId: string): Promise<string[]> {
  const rows = await prisma.matchPlayer.findMany({
    where: {
      match: { leagueId, status: MatchStatus.COMPLETED },
      stats: { heroName: { not: null } },
    },
    select: { stats: { select: { heroName: true } } },
  });

  const byKey = new Map<string, string>();
  for (const row of rows) {
    const name = row.stats?.heroName?.trim();
    if (!name) {
      continue;
    }
    const key = normalizeHeroNameKey(name);
    if (!byKey.has(key)) {
      byKey.set(key, name);
    }
  }

  return [...byKey.values()].sort((left, right) => left.localeCompare(right));
}
