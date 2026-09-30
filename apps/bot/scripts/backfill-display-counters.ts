/**
 * Backfill PlayerRating display counter columns from MatchPlayer history.
 * Idempotent: safe to re-run after partial failure.
 *
 * Run: npx tsx scripts/backfill-display-counters.ts
 * Dry: npx tsx scripts/backfill-display-counters.ts --dry-run
 * Non-local DB: add --allow-remote (use only in a controlled maintenance window)
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@dbz/db';
import { recomputeDisplayCountersForPlayer } from '../src/services/rating/display-counters.js';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

const DRY_RUN = process.argv.includes('--dry-run');
const ALLOW_REMOTE = process.argv.includes('--allow-remote');
const PROGRESS_EVERY = 100;

function assertSafeDatabaseTarget(url: string): void {
  if (ALLOW_REMOTE) return;
  if (/127\.0\.0\.1|localhost|:5433\b/.test(url)) return;
  throw new Error(
    'Refusing non-local DATABASE_URL. Use local Docker Postgres (127.0.0.1:5433) or pass --allow-remote.',
  );
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
    DRY_RUN
      ? 'Dry run — counting PlayerRating rows only.\n'
      : 'Backfilling display counters from match history…\n',
  );

  try {
    const total = await prisma.playerRating.count();
    console.log(`PlayerRating rows: ${total}\n`);
    if (total === 0) {
      console.log('Nothing to backfill.');
      return;
    }

    let processed = 0;
    let cursor: { leagueId: string; playerId: string } | undefined;

    while (true) {
      const batch = await prisma.playerRating.findMany({
        take: PROGRESS_EVERY,
        ...(cursor
          ? {
              skip: 1,
              cursor: { leagueId_playerId: cursor },
            }
          : {}),
        orderBy: [{ leagueId: 'asc' }, { playerId: 'asc' }],
        select: { leagueId: true, playerId: true },
      });

      if (batch.length === 0) break;

      for (const row of batch) {
        if (!DRY_RUN) {
          await recomputeDisplayCountersForPlayer(row.leagueId, row.playerId, prisma);
        }
        processed += 1;
        if (processed % PROGRESS_EVERY === 0 || processed === total) {
          console.log(`Progress: ${processed}/${total}`);
        }
      }

      const last = batch[batch.length - 1];
      cursor = { leagueId: last.leagueId, playerId: last.playerId };
      if (batch.length < PROGRESS_EVERY) break;
    }

    console.log(DRY_RUN ? 'Dry run complete.' : 'Backfill complete.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
