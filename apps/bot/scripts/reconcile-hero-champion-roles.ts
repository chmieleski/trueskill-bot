/**
 * Reconcile hero champion Discord roles for a guild:
 * 1) Pick rightful #1 holders (eligible = Discord-linked, not calibrating, ≥5 games on that hero)
 * 2) Strip the role from everyone else who still has it
 * 3) Ensure the rightful holder has the role
 *
 * Needs the **production** bot token (must be in the target guild) + DB URL, and the
 * Discord application must allow the **Server Members Intent**.
 *
 * Run (prod DB + prod token in env):
 *   cd apps/bot
 *   DATABASE_URL="$PROD_DIRECT_URL" DIRECT_URL="$PROD_DIRECT_URL" \
 *     DISCORD_TOKEN=… \
 *     npx tsx scripts/reconcile-hero-champion-roles.ts --allow-remote
 *
 * Options:
 *   GUILD_ID=1181331071867031582   (default)
 *   --dry-run                      print planned leagues only (no Discord writes)
 *   --allow-remote                 required when DATABASE_URL is not local
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

const DRY_RUN = process.argv.includes('--dry-run');
const ALLOW_REMOTE = process.argv.includes('--allow-remote');
const GUILD_ID = process.env.GUILD_ID?.trim() || '1181331071867031582';

function assertSafeDatabaseTarget(url: string): void {
  if (ALLOW_REMOTE) return;
  if (/127\.0\.0\.1|localhost|:5433\b/.test(url)) return;
  throw new Error(
    'Refusing non-local DATABASE_URL. Use local Docker Postgres (127.0.0.1:5433) or pass --allow-remote.',
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const token = process.env.DISCORD_TOKEN?.trim();
  if (!databaseUrl) {
    throw new Error('Missing DATABASE_URL');
  }
  if (!token) {
    throw new Error('Missing DISCORD_TOKEN');
  }
  assertSafeDatabaseTarget(databaseUrl);

  const { Client, Events, GatewayIntentBits } = await import('discord.js');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const { PrismaClient } = await import('@dbz/db');
  // Import after dotenv so apps/bot/src/config/env.ts sees DATABASE_URL.
  const { HERO_CHAMPION_MIN_HERO_MATCHES, sweepHeroChampionDiscordRoles, syncHeroChampionRoles } =
    await import('../src/services/hero-champion-roles/index.js');

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

  const leagues = await prisma.league.findMany({
    where: {
      guildId: GUILD_ID,
      status: 'ACTIVE',
      heroChampionRolesEnabled: true,
    },
    select: {
      id: true,
      name: true,
      gameId: true,
      heroChampionRoles: {
        select: { heroId: true, discordRoleId: true, holderDiscordId: true },
        orderBy: { heroId: 'asc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(
    `Guild ${GUILD_ID}: ${leagues.length} active league(s) with champion roles enabled (min hero matches=${HERO_CHAMPION_MIN_HERO_MATCHES})`,
  );
  for (const league of leagues) {
    console.log(`  ${league.name} (${league.id}) maps=${league.heroChampionRoles.length}`);
  }

  if (leagues.length === 0) {
    await prisma.$disconnect();
    return;
  }

  if (DRY_RUN) {
    console.log('\nDry run — no Discord changes.');
    await prisma.$disconnect();
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  await new Promise<void>((resolveReady, reject) => {
    client.once(Events.ClientReady, () => resolveReady());
    client.once(Events.Error, reject);
    client.login(token).catch(reject);
  });

  console.log(`\nLogged in as ${client.user?.tag}`);

  try {
    for (const league of leagues) {
      console.log(`\nSyncing ${league.name}…`);
      await syncHeroChampionRoles(client, league.id);
      const sweep = await sweepHeroChampionDiscordRoles(client, league.id);
      console.log(`  sweep: removed=${sweep.removed} ensured_holders=${sweep.ensured}`);

      const after = await prisma.leagueHeroChampionRole.findMany({
        where: { leagueId: league.id },
        orderBy: { heroId: 'asc' },
        select: { heroId: true, holderDiscordId: true },
      });
      for (const row of after) {
        console.log(`  hero ${row.heroId}: holder=${row.holderDiscordId ?? 'none'}`);
      }
    }
  } finally {
    await client.destroy();
    await prisma.$disconnect();
  }

  console.log('\nDone.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
