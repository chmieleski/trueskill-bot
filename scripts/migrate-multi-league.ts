/**
 * Migrate / repair a database to multi-league IHL tenancy.
 *
 * Schema DDL lives in Prisma migrations under `prisma/migrations/20260815*_multi_league_*`.
 * This script:
 *   1. Inspects whether those migrations are needed
 *   2. Ensures a GuildConfig row exists for the legacy Discord guild (so migrate backfill
 *      has a deterministic tenant for historical Match + rating rows)
 *   3. Optionally runs `prisma migrate deploy`
 *   4. Idempotently ensures Game + per-guild UDBR League rows and prints a health report
 *
 * Usage:
 *   MULTI_LEAGUE_LEGACY_GUILD_ID=<discord_snowflake> npm run db:migrate-multi-league
 *   MULTI_LEAGUE_LEGACY_GUILD_ID=<id> npm run db:migrate-multi-league -- --dry-run
 *   MULTI_LEAGUE_LEGACY_GUILD_ID=<id> npm run db:migrate-multi-league -- --skip-migrate
 *
 * Flags:
 *   --dry-run         Report only; no writes and no migrate deploy
 *   --skip-migrate    Skip `prisma migrate deploy` (data repair / verify only)
 *   --legacy-guild-id=<snowflake>  Override env MULTI_LEAGUE_LEGACY_GUILD_ID / GUILD_ID
 *
 * Requires DATABASE_URL (or DIRECT_URL). Prefer DIRECT_URL / session mode for migrate deploy.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '@prisma/client';
import { WARCRAFT3_UDBR_GAME_ID } from '../src/domain/games.js';

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_MIGRATE = process.argv.includes('--skip-migrate');

const DEFAULT_LEAGUE_NAME = 'UDBR';
const GAME_DISPLAY_NAME = 'Warcraft III — UDBR';

type SchemaProbe = {
  hasGameTable: boolean;
  hasLeagueTable: boolean;
  hasMatchLeagueId: boolean;
  matchLeagueIdNullable: boolean | null;
  hasPlayerRatingLeagueId: boolean;
  hasGuildWc3statsColumns: boolean;
  hasLeagueWc3statsColumns: boolean;
  hasGuildSlotMapTable: boolean;
  hasLeagueSlotMapTable: boolean;
};

function argValue(prefix: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (!hit) return undefined;
  const value = hit.slice(prefix.length).trim();
  return value.length > 0 ? value : undefined;
}

function resolveLegacyGuildId(): string {
  const fromArg = argValue('--legacy-guild-id=');
  const fromEnv =
    process.env.MULTI_LEAGUE_LEGACY_GUILD_ID?.trim() ||
    process.env.GUILD_ID?.trim() ||
    undefined;
  const id = fromArg || fromEnv;
  if (!id) {
    throw new Error(
      'Missing legacy guild id. Set MULTI_LEAGUE_LEGACY_GUILD_ID (or GUILD_ID), ' +
        'or pass --legacy-guild-id=<discord_snowflake>.',
    );
  }
  return id;
}

function resolveDatabaseUrl(): string {
  const url =
    process.env.DIRECT_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    undefined;
  if (!url) {
    throw new Error('Missing DATABASE_URL (or DIRECT_URL).');
  }
  return url;
}

async function tableExists(db: PrismaClient, table: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${table}
    ) AS "exists"
  `;
  return rows[0]?.exists === true;
}

async function columnInfo(
  db: PrismaClient,
  table: string,
  column: string,
): Promise<{ exists: boolean; isNullable: boolean | null }> {
  const rows = await db.$queryRaw<{ is_nullable: string | null }[]>`
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${table}
      AND column_name = ${column}
  `;
  if (rows.length === 0) {
    return { exists: false, isNullable: null };
  }
  return { exists: true, isNullable: rows[0]?.is_nullable === 'YES' };
}

async function probeSchema(db: PrismaClient): Promise<SchemaProbe> {
  const matchLeague = await columnInfo(db, 'Match', 'leagueId');
  const ratingLeague = await columnInfo(db, 'PlayerRating', 'leagueId');
  const guildWc3 = await columnInfo(db, 'GuildConfig', 'wc3statsEnabled');
  const leagueWc3 = await columnInfo(db, 'League', 'wc3statsEnabled');

  return {
    hasGameTable: await tableExists(db, 'Game'),
    hasLeagueTable: await tableExists(db, 'League'),
    hasMatchLeagueId: matchLeague.exists,
    matchLeagueIdNullable: matchLeague.isNullable,
    hasPlayerRatingLeagueId: ratingLeague.exists,
    hasGuildWc3statsColumns: guildWc3.exists,
    hasLeagueWc3statsColumns: leagueWc3.exists,
    hasGuildSlotMapTable: await tableExists(db, 'GuildWc3statsSlotMap'),
    hasLeagueSlotMapTable: await tableExists(db, 'LeagueWc3statsSlotMap'),
  };
}

function schemaNeedsMigrate(probe: SchemaProbe): boolean {
  return !(
    probe.hasGameTable &&
    probe.hasLeagueTable &&
    probe.hasMatchLeagueId &&
    probe.matchLeagueIdNullable === false &&
    probe.hasPlayerRatingLeagueId &&
    probe.hasLeagueWc3statsColumns &&
    probe.hasLeagueSlotMapTable &&
    !probe.hasGuildWc3statsColumns &&
    !probe.hasGuildSlotMapTable
  );
}

async function ensureLegacyGuildConfig(
  db: PrismaClient,
  legacyGuildId: string,
): Promise<void> {
  const hasGuildConfig = await tableExists(db, 'GuildConfig');
  if (!hasGuildConfig) {
    console.log('  (no GuildConfig table yet — migrate will create related structures)');
    return;
  }

  const existing = await db.$queryRaw<{ guildId: string }[]>`
    SELECT "guildId" FROM "GuildConfig" WHERE "guildId" = ${legacyGuildId} LIMIT 1
  `;
  if (existing.length > 0) {
    console.log(`  GuildConfig already has legacy guild ${legacyGuildId}`);
    return;
  }

  if (DRY_RUN) {
    console.log(`  [dry-run] would upsert GuildConfig for legacy guild ${legacyGuildId}`);
    return;
  }

  // Minimal row so migrate backfill creates a League for this snowflake.
  await db.$executeRaw`
    INSERT INTO "GuildConfig" ("guildId", "createdAt", "updatedAt")
    VALUES (${legacyGuildId}, NOW(), NOW())
    ON CONFLICT ("guildId") DO NOTHING
  `;
  console.log(`  Upserted GuildConfig for legacy guild ${legacyGuildId}`);
}

function runMigrateDeploy(databaseUrl: string): void {
  console.log('\nRunning `npx prisma migrate deploy`…');
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      // Prisma also reads DIRECT_URL when present in schema/env — keep caller's value.
    },
  });
}

async function ensureGameAndLeagues(
  db: PrismaClient,
  legacyGuildId: string,
): Promise<{ gameReady: boolean; leaguesCreated: number; legacyLeagueId: string | null }> {
  if (DRY_RUN) {
    console.log('  [dry-run] would ensure Game + UDBR leagues for every GuildConfig');
    return { gameReady: true, leaguesCreated: 0, legacyLeagueId: null };
  }

  await db.game.upsert({
    where: { id: WARCRAFT3_UDBR_GAME_ID },
    create: { id: WARCRAFT3_UDBR_GAME_ID, displayName: GAME_DISPLAY_NAME },
    update: { displayName: GAME_DISPLAY_NAME },
  });

  const guildRows = await db.guildConfig.findMany({ select: { guildId: true } });
  const guildIds = [...new Set([...guildRows.map((g) => g.guildId), legacyGuildId])];

  let leaguesCreated = 0;
  for (const guildId of guildIds) {
    const existing = await db.league.findFirst({
      where: {
        guildId,
        gameId: WARCRAFT3_UDBR_GAME_ID,
        name: DEFAULT_LEAGUE_NAME,
      },
    });
    if (existing) continue;

    await db.league.create({
      data: {
        guildId,
        gameId: WARCRAFT3_UDBR_GAME_ID,
        name: DEFAULT_LEAGUE_NAME,
      },
    });
    leaguesCreated += 1;
  }

  const legacyLeague = await db.league.findFirst({
    where: {
      guildId: legacyGuildId,
      gameId: WARCRAFT3_UDBR_GAME_ID,
      name: DEFAULT_LEAGUE_NAME,
    },
  });

  return {
    gameReady: true,
    leaguesCreated,
    legacyLeagueId: legacyLeague?.id ?? null,
  };
}

/**
 * If an earlier migrate attached history to LEGACY_UNSET (or another wrong guild),
 * move orphan Match / rating rows onto the intended legacy league.
 * Safe when those tables only contain single-tenant history.
 */
async function rehomeLegacyHistory(
  db: PrismaClient,
  legacyLeagueId: string,
  legacyGuildId: string,
): Promise<void> {
  const wrongLeagues = await db.league.findMany({
    where: {
      OR: [{ guildId: 'LEGACY_UNSET' }, { guildId: { not: legacyGuildId }, matches: { some: {} } }],
      gameId: WARCRAFT3_UDBR_GAME_ID,
    },
    select: { id: true, guildId: true, _count: { select: { matches: true } } },
  });

  const candidates = wrongLeagues.filter(
    (l) => l.guildId === 'LEGACY_UNSET' || l._count.matches > 0,
  );

  if (candidates.length === 0) {
    console.log('  No misplaced historical leagues detected');
    return;
  }

  for (const league of candidates) {
    if (league.id === legacyLeagueId) continue;
    if (league.guildId !== 'LEGACY_UNSET') {
      console.log(
        `  Skipping league ${league.id} (guild ${league.guildId}, ${league._count.matches} matches) — not LEGACY_UNSET; inspect manually`,
      );
      continue;
    }

    if (DRY_RUN) {
      console.log(
        `  [dry-run] would move matches/ratings from LEGACY_UNSET league ${league.id} → ${legacyLeagueId}`,
      );
      continue;
    }

    await db.$transaction(async (tx) => {
      const matchCount = await tx.match.updateMany({
        where: { leagueId: league.id },
        data: { leagueId: legacyLeagueId },
      });
      // Ratings: copy then delete if target missing; updateMany cannot change PK parts.
      await rehomeRatings(tx, league.id, legacyLeagueId);
      console.log(
        `  Moved ${matchCount.count} matches from LEGACY_UNSET league ${league.id} → ${legacyLeagueId}`,
      );
    });
  }
}

async function rehomeRatings(
  tx: Prisma.TransactionClient,
  fromLeagueId: string,
  toLeagueId: string,
): Promise<void> {
  const globals = await tx.playerRating.findMany({ where: { leagueId: fromLeagueId } });
  for (const row of globals) {
    await tx.playerRating.upsert({
      where: {
        leagueId_playerId: { leagueId: toLeagueId, playerId: row.playerId },
      },
      create: {
        leagueId: toLeagueId,
        playerId: row.playerId,
        mu: row.mu,
        sigma: row.sigma,
      },
      update: { mu: row.mu, sigma: row.sigma },
    });
  }
  if (globals.length > 0) {
    await tx.playerRating.deleteMany({ where: { leagueId: fromLeagueId } });
  }

  const heroes = await tx.playerHeroRating.findMany({ where: { leagueId: fromLeagueId } });
  for (const row of heroes) {
    await tx.playerHeroRating.upsert({
      where: {
        leagueId_playerId_heroId: {
          leagueId: toLeagueId,
          playerId: row.playerId,
          heroId: row.heroId,
        },
      },
      create: {
        leagueId: toLeagueId,
        playerId: row.playerId,
        heroId: row.heroId,
        mu: row.mu,
        sigma: row.sigma,
        matchesPlayed: row.matchesPlayed,
      },
      update: {
        mu: row.mu,
        sigma: row.sigma,
        matchesPlayed: row.matchesPlayed,
      },
    });
  }
  if (heroes.length > 0) {
    await tx.playerHeroRating.deleteMany({ where: { leagueId: fromLeagueId } });
  }
}

async function printReport(db: PrismaClient, legacyGuildId: string): Promise<void> {
  const leagues = await db.league.findMany({
    orderBy: [{ guildId: 'asc' }, { name: 'asc' }],
    include: {
      _count: {
        select: {
          matches: true,
          ratings: true,
          heroRatings: true,
          channelBindings: true,
          wc3statsSlotMaps: true,
        },
      },
    },
  });

  console.log('\n── Leagues ──────────────────────────────────────────────');
  for (const league of leagues) {
    const marker = league.guildId === legacyGuildId ? ' (legacy guild)' : '';
    console.log(
      `  ${league.name}  guild=${league.guildId}${marker}\n` +
        `    id=${league.id}  game=${league.gameId}\n` +
        `    matches=${league._count.matches}  ratings=${league._count.ratings}  ` +
        `heroRatings=${league._count.heroRatings}  bindings=${league._count.channelBindings}  ` +
        `slots=${league._count.wc3statsSlotMaps}  wc3stats=${league.wc3statsEnabled ? 'on' : 'off'}`,
    );
  }

  const orphanMatches = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "Match" m
    LEFT JOIN "League" l ON l."id" = m."leagueId"
    WHERE l."id" IS NULL
  `.catch(() => [{ count: BigInt(0) }]);

  console.log('\n── Checks ───────────────────────────────────────────────');
  console.log(`  orphan matches (no league row): ${orphanMatches[0]?.count ?? 0}`);
  console.log(
    '  Next: /league bind lobby channels; re-run UDBR preset if import needed; ' +
      'deploy global slash commands if GUILD_ID is empty.',
  );
}

function createDb(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
}

async function main(): Promise<void> {
  const legacyGuildId = resolveLegacyGuildId();
  const databaseUrl = resolveDatabaseUrl();

  console.log('Multi-league database migration');
  console.log(`  legacy guild: ${legacyGuildId}`);
  console.log(`  dry-run: ${DRY_RUN}`);
  console.log(`  skip-migrate: ${SKIP_MIGRATE}`);
  console.log('');

  let db = createDb(databaseUrl);

  try {
    let probe = await probeSchema(db);
    console.log('── Schema probe ─────────────────────────────────────────');
    console.log(`  Game table:              ${probe.hasGameTable}`);
    console.log(`  League table:            ${probe.hasLeagueTable}`);
    console.log(
      `  Match.leagueId:           ${probe.hasMatchLeagueId} (nullable=${probe.matchLeagueIdNullable})`,
    );
    console.log(`  PlayerRating.leagueId:   ${probe.hasPlayerRatingLeagueId}`);
    console.log(`  GuildConfig wc3stats*:   ${probe.hasGuildWc3statsColumns}`);
    console.log(`  League wc3stats*:        ${probe.hasLeagueWc3statsColumns}`);
    console.log(`  GuildWc3statsSlotMap:    ${probe.hasGuildSlotMapTable}`);
    console.log(`  LeagueWc3statsSlotMap:   ${probe.hasLeagueSlotMapTable}`);

    const needsMigrate = schemaNeedsMigrate(probe);
    console.log(`\n  needs prisma migrate:    ${needsMigrate}`);

    console.log('\n── Ensure legacy GuildConfig ────────────────────────────');
    await ensureLegacyGuildConfig(db, legacyGuildId);

    if (needsMigrate && !SKIP_MIGRATE) {
      if (DRY_RUN) {
        console.log('\n[dry-run] would run `npx prisma migrate deploy`');
        console.log('Dry run complete (data ensure skipped until schema exists).');
        return;
      }

      await db.$disconnect();
      runMigrateDeploy(databaseUrl);
      db = createDb(databaseUrl);
      probe = await probeSchema(db);
      if (schemaNeedsMigrate(probe)) {
        throw new Error(
          'Schema still incomplete after migrate deploy. Check `npx prisma migrate status`.',
        );
      }
    } else if (needsMigrate && SKIP_MIGRATE) {
      throw new Error(
        'Schema is not fully multi-league yet. Re-run without --skip-migrate, or run `npx prisma migrate deploy` first.',
      );
    } else {
      console.log('\nSchema already multi-league — skipping migrate deploy.');
    }

    console.log('\n── Ensure Game + leagues ───────────────────────────────');
    const ensured = await ensureGameAndLeagues(db, legacyGuildId);
    console.log(`  leagues created: ${ensured.leaguesCreated}`);
    if (!ensured.legacyLeagueId && !DRY_RUN) {
      throw new Error(`Failed to resolve UDBR league for legacy guild ${legacyGuildId}`);
    }

    if (ensured.legacyLeagueId) {
      console.log('\n── Rehome LEGACY_UNSET history (if any) ────────────────');
      await rehomeLegacyHistory(db, ensured.legacyLeagueId, legacyGuildId);
    }

    if (!DRY_RUN) {
      await printReport(db, legacyGuildId);
    }

    console.log(DRY_RUN ? '\nDry run complete.' : '\nMigration repair complete.');
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
