import type { Client } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import {
  fetchMemberBestEffort,
  tryAddRole,
  tryRemoveRole,
} from '../hero-champion-roles/sync-hero-champion-roles.js';
import {
  LIVE_LEADERBOARD_MAX_SIZE,
  loadOverallLeaderboardTop,
} from '../leaderboard/leaderboard.js';
import { pickRankHolders } from './pick-rank-holders.js';

const log = createLogger('rank_roles');

const REASON = 'Leaderboard rank role sync';

/**
 * Sync Discord roles for overall leaderboard #1–#3 in a league.
 * Removes stale holders before granting, so a player moving #2 → #1 never holds both.
 * Best-effort: never throws for Discord failures.
 */
export async function syncRankRoles(client: Client, leagueId: string): Promise<void> {
  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    select: { guildId: true, status: true, rankRolesEnabled: true, rankRoles: true },
  });
  if (!league?.rankRolesEnabled || league.status === 'ARCHIVED' || league.rankRoles.length === 0) {
    return;
  }

  // ponytail: loads up to 100 rows so incumbent tie-stickiness works past #3; ties wider than that are ignored.
  const { entries } = await loadOverallLeaderboardTop(leagueId, LIVE_LEADERBOARD_MAX_SIZE);
  const next = pickRankHolders({
    entries,
    incumbents: new Map(league.rankRoles.map((m) => [m.rank, m.holderDiscordId])),
  });

  const changes = league.rankRoles.map((mapping) => ({
    mapping,
    nextHolderId: next.get(mapping.rank) ?? null,
  }));

  for (const { mapping, nextHolderId } of changes) {
    if (mapping.holderDiscordId && mapping.holderDiscordId !== nextHolderId) {
      const previous = await fetchMemberBestEffort(client, league.guildId, mapping.holderDiscordId);
      await tryRemoveRole(
        previous,
        mapping.discordRoleId,
        { leagueId, rank: mapping.rank, discordId: mapping.holderDiscordId },
        REASON,
      );
    }
  }

  for (const { mapping, nextHolderId } of changes) {
    // Also re-grants an unchanged holder (manual remove / rejoin).
    if (nextHolderId) {
      const member = await fetchMemberBestEffort(client, league.guildId, nextHolderId);
      await tryAddRole(
        member,
        mapping.discordRoleId,
        { leagueId, rank: mapping.rank, discordId: nextHolderId },
        REASON,
      );
    }
    if (nextHolderId !== mapping.holderDiscordId) {
      await prisma.leagueRankRole.update({
        where: { leagueId_rank: { leagueId, rank: mapping.rank } },
        data: { holderDiscordId: nextHolderId },
      });
    }
  }
}

/** Remove the rank role from its holder and delete the mapping. Best-effort for Discord. */
export async function clearRankRoleMapping(
  client: Client,
  leagueId: string,
  rank: number,
): Promise<void> {
  const mapping = await prisma.leagueRankRole.findUnique({
    where: { leagueId_rank: { leagueId, rank } },
    include: { league: { select: { guildId: true } } },
  });
  if (!mapping) {
    return;
  }
  if (mapping.holderDiscordId) {
    const member = await fetchMemberBestEffort(
      client,
      mapping.league.guildId,
      mapping.holderDiscordId,
    );
    await tryRemoveRole(
      member,
      mapping.discordRoleId,
      { leagueId, rank, discordId: mapping.holderDiscordId },
      REASON,
    );
  }
  await prisma.leagueRankRole.delete({ where: { leagueId_rank: { leagueId, rank } } });
}

/** Scheduled tick: sync active, enabled, dirty leagues (FIFO by last sync), at most `maxGuilds` guilds. */
export async function runRankRoleSyncTick(
  client: Client,
  maxGuilds: number,
): Promise<{ leaguesSynced: number; errors: number }> {
  const candidates = await prisma.league.findMany({
    where: { status: 'ACTIVE', rankRolesEnabled: true, rankRolesDirty: true },
    select: { id: true, guildId: true },
    orderBy: [{ lastRankRoleSyncAt: 'asc' }, { id: 'asc' }],
  });
  const guilds = [...new Set(candidates.map((l) => l.guildId))].slice(0, maxGuilds);
  let leaguesSynced = 0;
  let errors = 0;
  for (const league of candidates.filter((l) => guilds.includes(l.guildId))) {
    try {
      await syncRankRoles(client, league.id);
      await prisma.league.update({
        where: { id: league.id },
        data: { rankRolesDirty: false, lastRankRoleSyncAt: new Date() },
      });
      leaguesSynced += 1;
    } catch (error) {
      errors += 1;
      log.warn({ err: error, leagueId: league.id }, 'Rank role sync failed during scheduled tick');
    }
  }
  return { leaguesSynced, errors };
}
