import type { Client } from 'discord.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { runRankRoleSyncTick } from '../rank-roles/sync-rank-roles.js';
import { syncHeroChampionRoles } from './sync-hero-champion-roles.js';

const log = createLogger('hero_champion_role_scheduler');

export type HeroChampionSyncTickResult = {
  guildsProcessed: number;
  leaguesSynced: number;
  errors: number;
};

let intervalHandle: ReturnType<typeof setInterval> | undefined;

/**
 * Execute a single scheduled sync tick for hero champion roles.
 * Only syncs active leagues with heroChampionRolesEnabled=true and heroChampionRolesDirty=true.
 * Limits processing to max X guilds per tick (FIFO by lastHeroChampionSyncAt).
 */
export async function runHeroChampionRoleSyncTick(
  client: Client,
  options?: { maxGuilds?: number },
): Promise<HeroChampionSyncTickResult> {
  const maxGuilds = options?.maxGuilds ?? env.heroChampionRoleSyncMaxGuilds;

  const candidateLeagues = await prisma.league.findMany({
    where: {
      status: 'ACTIVE',
      heroChampionRolesEnabled: true,
      heroChampionRolesDirty: true,
    },
    select: {
      id: true,
      guildId: true,
      lastHeroChampionSyncAt: true,
    },
    orderBy: [{ lastHeroChampionSyncAt: 'asc' }, { id: 'asc' }],
  });

  if (candidateLeagues.length === 0) {
    log.debug('No dirty active hero champion role leagues to sync');
    return { guildsProcessed: 0, leaguesSynced: 0, errors: 0 };
  }

  const selectedGuildIds: string[] = [];
  for (const league of candidateLeagues) {
    if (!selectedGuildIds.includes(league.guildId)) {
      selectedGuildIds.push(league.guildId);
      if (selectedGuildIds.length >= maxGuilds) {
        break;
      }
    }
  }

  const selectedGuildSet = new Set(selectedGuildIds);
  const leaguesToSync = candidateLeagues.filter((l) => selectedGuildSet.has(l.guildId));

  let leaguesSynced = 0;
  let errors = 0;

  for (const league of leaguesToSync) {
    try {
      await syncHeroChampionRoles(client, league.id);
      await prisma.league.update({
        where: { id: league.id },
        data: {
          heroChampionRolesDirty: false,
          lastHeroChampionSyncAt: new Date(),
        },
      });
      leaguesSynced += 1;
    } catch (error) {
      errors += 1;
      log.warn(
        { err: error, leagueId: league.id, guildId: league.guildId },
        'Hero champion role sync failed during scheduled tick',
      );
    }
  }

  log.info(
    {
      guildsProcessed: selectedGuildIds.length,
      leaguesSynced,
      errors,
      maxGuilds,
    },
    'Hero champion role scheduled tick completed',
  );

  return {
    guildsProcessed: selectedGuildIds.length,
    leaguesSynced,
    errors,
  };
}

export function startHeroChampionRoleScheduler(client: Client): void {
  if (intervalHandle) {
    log.warn('Hero champion role scheduler already running');
    return;
  }

  const intervalMs = Math.max(1, env.heroChampionRoleSyncIntervalMinutes) * 60 * 1000;

  const tick = (): void => {
    void runHeroChampionRoleSyncTick(client).catch((error: unknown) => {
      log.error({ err: error }, 'Hero champion role scheduler tick failed');
    });
    // Leaderboard rank roles share this cadence and guild cap.
    void runRankRoleSyncTick(client, env.heroChampionRoleSyncMaxGuilds).catch((error: unknown) => {
      log.error({ err: error }, 'Rank role scheduler tick failed');
    });
  };

  // Run initial tick shortly after startup (15 seconds) to catch up dirty leagues.
  setTimeout(tick, 15_000);
  intervalHandle = setInterval(tick, intervalMs);

  log.info(
    {
      intervalMinutes: env.heroChampionRoleSyncIntervalMinutes,
      maxGuilds: env.heroChampionRoleSyncMaxGuilds,
    },
    'Hero champion role scheduler started',
  );
}

export function stopHeroChampionRoleScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
    log.info('Hero champion role scheduler stopped');
  }
}
