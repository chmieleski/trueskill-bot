/**
 * Verify PlayerRating display counter columns match MatchPlayer history aggregation.
 * Does not use loadMatchDisplayStatsByPlayer (safe regardless of DISPLAY_STATS_SOURCE).
 *
 * Run: npx tsx scripts/verify-display-counters.ts
 * All leagues (including archived): npx tsx scripts/verify-display-counters.ts --all-leagues
 * Non-local DB: add --allow-remote
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { LeagueStatus, PrismaClient } from '@dbz/db';
import {
  countersEqualStats,
  displayStatsFromCounters,
} from '../src/services/rating/display-counters.js';
import {
  loadMatchDisplayStatsFromHistory,
  type PlayerMatchDisplayStats,
} from '../src/services/rating/rank-reset-display.js';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

const ALL_LEAGUES = process.argv.includes('--all-leagues');
const ALLOW_REMOTE = process.argv.includes('--allow-remote');
const BATCH_SIZE = 50;

const ZERO_STATS: PlayerMatchDisplayStats = {
  games: 0,
  wins: 0,
  losses: 0,
  quits: 0,
  griefs: 0,
  dcs: 0,
};

function assertSafeDatabaseTarget(url: string): void {
  if (ALLOW_REMOTE) return;
  if (/127\.0\.0\.1|localhost|:5433\b/.test(url)) return;
  throw new Error(
    'Refusing non-local DATABASE_URL. Use local Docker Postgres (127.0.0.1:5433) or pass --allow-remote.',
  );
}

function formatStats(s: PlayerMatchDisplayStats): string {
  return `W=${s.wins} L=${s.losses} Q=${s.quits} G=${s.griefs} DC=${s.dcs}`;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Missing DATABASE_URL');
  }
  assertSafeDatabaseTarget(databaseUrl);

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

  console.log(
    ALL_LEAGUES
      ? 'Verifying display counters (all leagues)…\n'
      : 'Verifying display counters (ACTIVE leagues only)…\n',
  );

  let mismatches = 0;
  let checked = 0;

  try {
    const leagues = await prisma.league.findMany({
      where: ALL_LEAGUES ? undefined : { status: LeagueStatus.ACTIVE },
      select: { id: true, name: true, status: true },
      orderBy: { id: 'asc' },
    });

    console.log(`Leagues: ${leagues.length}\n`);

    for (const league of leagues) {
      const ratings = await prisma.playerRating.findMany({
        where: { leagueId: league.id },
        select: {
          playerId: true,
          displayWins: true,
          displayLosses: true,
          displayQuits: true,
          displayGriefs: true,
          displayDcs: true,
        },
        orderBy: { playerId: 'asc' },
      });

      if (ratings.length === 0) continue;

      for (let i = 0; i < ratings.length; i += BATCH_SIZE) {
        const chunk = ratings.slice(i, i + BATCH_SIZE);
        const playerIds = chunk.map((r) => r.playerId);
        const historyMap = await loadMatchDisplayStatsFromHistory(league.id, playerIds, prisma);

        for (const row of chunk) {
          checked += 1;
          const counters = displayStatsFromCounters(row);
          const history = historyMap.get(row.playerId) ?? ZERO_STATS;
          if (!countersEqualStats(counters, history)) {
            mismatches += 1;
            console.log(
              `MISMATCH league=${league.id} (${league.name}, ${league.status}) player=${row.playerId}`,
            );
            console.log(`  counters: ${formatStats(counters)}`);
            console.log(`  history:  ${formatStats(history)}`);
          }
        }
      }
    }

    console.log(`\nChecked ${checked} PlayerRating row(s). Mismatches: ${mismatches}.`);
    if (mismatches > 0) {
      process.exit(1);
    }
    console.log('OK — counters match history.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
