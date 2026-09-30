/**
 * One-shot: fix hero champion role DB state after a season rollover that left
 * the archived league enabled with the same Discord role IDs as the successor.
 *
 * Default target: guild 1181331071867031582 (UDBR archived → Season 1).
 *
 * Run (prod):
 *   cd apps/bot && DATABASE_URL="$PROD_DIRECT_URL" DIRECT_URL="$PROD_DIRECT_URL" npx tsx scripts/fix-hero-champion-rollover-handoff.ts
 *
 * Optional:
 *   GUILD_ID=… npx tsx scripts/fix-hero-champion-rollover-handoff.ts
 *
 * Does DB only (no Discord API). After deploy, finish a rated match or
 * `/hero_champion_config enable enabled:True` on the active league to sync roles.
 */
import 'dotenv/config';
import { PrismaClient } from '@dbz/db';
import { HERO_CHAMPION_MIN_HERO_MATCHES } from '../src/services/hero-champion-roles/load-eligible-candidates.js';

const GUILD_ID = process.env.GUILD_ID?.trim() || '1181331071867031582';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const leagues = await prisma.league.findMany({
    where: { guildId: GUILD_ID, gameId: 'warcraft3_udbr' },
    select: {
      id: true,
      name: true,
      status: true,
      heroChampionRolesEnabled: true,
      heroChampionRoles: {
        select: { heroId: true, discordRoleId: true, holderDiscordId: true },
        orderBy: { heroId: 'asc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (leagues.length === 0) {
    throw new Error(`No warcraft3_udbr leagues for guild ${GUILD_ID}`);
  }

  const archived = leagues.filter((l) => l.status === 'ARCHIVED');
  const active = leagues.filter((l) => l.status === 'ACTIVE');

  console.log(`Guild ${GUILD_ID}: ${leagues.length} UDBR league(s)`);
  for (const l of leagues) {
    console.log(
      `  ${l.status} ${l.name} (${l.id}) enabled=${l.heroChampionRolesEnabled} maps=${l.heroChampionRoles.length}`,
    );
  }

  await prisma.$transaction(async (tx) => {
    for (const league of archived) {
      await tx.league.update({
        where: { id: league.id },
        data: { heroChampionRolesEnabled: false },
      });
      await tx.leagueHeroChampionRole.updateMany({
        where: { leagueId: league.id },
        data: { holderDiscordId: null },
      });
      console.log(`Archived ${league.name}: disabled + cleared holders`);
    }

    for (const league of active) {
      // Ensure mappings exist: if empty but an archived predecessor has them, copy.
      if (league.heroChampionRoles.length === 0) {
        const source = archived.find((a) => a.heroChampionRoles.length > 0);
        if (source) {
          await tx.leagueHeroChampionRole.createMany({
            data: source.heroChampionRoles.map((row) => ({
              leagueId: league.id,
              heroId: row.heroId,
              discordRoleId: row.discordRoleId,
              holderDiscordId: null,
            })),
          });
          console.log(
            `Active ${league.name}: copied ${source.heroChampionRoles.length} mappings from ${source.name}`,
          );
        }
      }

      await tx.league.update({
        where: { id: league.id },
        data: { heroChampionRolesEnabled: true },
      });

      const rows = await tx.leagueHeroChampionRole.findMany({
        where: { leagueId: league.id, holderDiscordId: { not: null } },
      });

      for (const row of rows) {
        const player = await tx.player.findFirst({
          where: { gameId: 'warcraft3_udbr', discordId: row.holderDiscordId! },
          select: { id: true },
        });
        const heroGames = player
          ? ((
              await tx.playerHeroRating.findUnique({
                where: {
                  leagueId_playerId_heroId: {
                    leagueId: league.id,
                    playerId: player.id,
                    heroId: row.heroId,
                  },
                },
                select: { matchesPlayed: true },
              })
            )?.matchesPlayed ?? 0)
          : 0;

        if (heroGames < HERO_CHAMPION_MIN_HERO_MATCHES) {
          await tx.leagueHeroChampionRole.update({
            where: { leagueId_heroId: { leagueId: league.id, heroId: row.heroId } },
            data: { holderDiscordId: null },
          });
          console.log(
            `Active ${league.name}: cleared hero ${row.heroId} holder (hero games ${heroGames} < ${HERO_CHAMPION_MIN_HERO_MATCHES})`,
          );
        }
      }

      console.log(`Active ${league.name}: enabled`);
    }
  });

  console.log(
    '\nDone. Discord roles sync on the next rating change or /hero_champion_config enable.',
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
