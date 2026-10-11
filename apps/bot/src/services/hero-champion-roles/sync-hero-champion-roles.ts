import type { Client, GuildMember } from 'discord.js';
import { getGameProfile } from '../../domain/game-profile.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { loadEligibleHeroCandidates } from './load-eligible-candidates.js';
import { pickHeroChampion } from './pick-hero-champion.js';

const log = createLogger('hero_champion_roles');

/** Best-effort role removal; logs instead of throwing. True when a role was removed. Shared with rank role sync. */
export async function tryRemoveRole(
  member: GuildMember | null,
  roleId: string,
  context: Record<string, unknown>,
  reason = 'Hero champion role sync',
): Promise<boolean> {
  if (!member?.roles.cache.has(roleId)) {
    return false;
  }
  try {
    await member.roles.remove(roleId, reason);
    return true;
  } catch (error) {
    log.warn({ err: error, ...context }, 'Failed to remove synced Discord role');
    return false;
  }
}

/** Best-effort role grant; logs instead of throwing. Shared with rank role sync. */
export async function tryAddRole(
  member: GuildMember | null,
  roleId: string,
  context: Record<string, unknown>,
  reason = 'Hero champion role sync',
): Promise<void> {
  if (!member || member.roles.cache.has(roleId)) {
    return;
  }
  try {
    await member.roles.add(roleId, reason);
  } catch (error) {
    log.warn({ err: error, ...context }, 'Failed to add synced Discord role');
  }
}

/** Fetch a guild member, or null when missing / Discord fails. */
export async function fetchMemberBestEffort(
  client: Client,
  guildId: string,
  discordId: string,
): Promise<GuildMember | null> {
  try {
    const guild = await client.guilds.fetch(guildId);
    return await guild.members.fetch(discordId);
  } catch (error) {
    log.warn({ err: error, guildId, discordId }, 'Failed to fetch member for champion sync');
    return null;
  }
}

/**
 * Sync Discord #1 hero roles for a league. Best-effort: never throws for Discord failures.
 */
export async function syncHeroChampionRoles(client: Client, leagueId: string): Promise<void> {
  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    select: {
      guildId: true,
      gameId: true,
      status: true,
      heroChampionRolesEnabled: true,
      heroChampionRoles: true,
    },
  });

  if (!league?.heroChampionRolesEnabled || league.status === 'ARCHIVED') {
    return;
  }

  let profile;
  try {
    profile = getGameProfile(league.gameId);
  } catch {
    log.warn({ leagueId, gameId: league.gameId }, 'Unknown game; skip champion sync');
    return;
  }

  if (!profile.heroChampionRoles) {
    return;
  }

  const mappings = league.heroChampionRoles;
  if (mappings.length === 0) {
    return;
  }

  for (const mapping of mappings) {
    const candidates = await loadEligibleHeroCandidates(leagueId, mapping.heroId);
    const nextHolderId = pickHeroChampion({
      candidates,
      incumbentDiscordId: mapping.holderDiscordId,
    });

    if (nextHolderId === mapping.holderDiscordId) {
      // Ensure holder still has the role (manual remove / rejoin).
      if (nextHolderId) {
        const member = await fetchMemberBestEffort(client, league.guildId, nextHolderId);
        await tryAddRole(member, mapping.discordRoleId, {
          leagueId,
          heroId: mapping.heroId,
          discordId: nextHolderId,
        });
      }
      continue;
    }

    if (mapping.holderDiscordId) {
      const previous = await fetchMemberBestEffort(client, league.guildId, mapping.holderDiscordId);
      await tryRemoveRole(previous, mapping.discordRoleId, {
        leagueId,
        heroId: mapping.heroId,
        discordId: mapping.holderDiscordId,
      });
    }

    if (nextHolderId) {
      const next = await fetchMemberBestEffort(client, league.guildId, nextHolderId);
      await tryAddRole(next, mapping.discordRoleId, {
        leagueId,
        heroId: mapping.heroId,
        discordId: nextHolderId,
      });
    }

    await prisma.leagueHeroChampionRole.update({
      where: {
        leagueId_heroId: { leagueId, heroId: mapping.heroId },
      },
      data: { holderDiscordId: nextHolderId },
    });
  }
}

/**
 * Remove the champion role from the current holder and clear holderDiscordId.
 * Used when clearing a mapping. Best-effort for Discord.
 */
export async function clearHeroChampionHolder(
  client: Client,
  leagueId: string,
  heroId: number,
): Promise<void> {
  const mapping = await prisma.leagueHeroChampionRole.findUnique({
    where: { leagueId_heroId: { leagueId, heroId } },
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
    await tryRemoveRole(member, mapping.discordRoleId, {
      leagueId,
      heroId,
      discordId: mapping.holderDiscordId,
    });
  }

  await prisma.leagueHeroChampionRole.delete({
    where: { leagueId_heroId: { leagueId, heroId } },
  });
}

/**
 * Best-effort Discord role strip for archived-season holders after rollover.
 * Does not touch the database.
 */
export async function stripHeroChampionDiscordRoles(
  client: Client,
  guildId: string,
  holders: Array<{ discordRoleId: string; holderDiscordId: string }>,
): Promise<void> {
  for (const { discordRoleId, holderDiscordId } of holders) {
    const member = await fetchMemberBestEffort(client, guildId, holderDiscordId);
    await tryRemoveRole(member, discordRoleId, {
      guildId,
      discordId: holderDiscordId,
      roleId: discordRoleId,
      reason: 'league_rollover',
    });
  }
}

/**
 * Strip every mapped hero champion / rank role (this league) from anyone who is not
 * its DB holder. Fixes duplicates left by old remaps or failed removals.
 * Works without the privileged GuildMembers intent by fetching each Discord-linked
 * player of the league's game one by one. Best-effort; returns how many roles it removed.
 */
export async function sweepStrayRoleHolders(client: Client, leagueId: string): Promise<number> {
  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    select: {
      guildId: true,
      gameId: true,
      heroChampionRoles: { select: { discordRoleId: true, holderDiscordId: true } },
      rankRoles: { select: { discordRoleId: true, holderDiscordId: true } },
    },
  });
  if (!league) return 0;
  const mappings = [...league.heroChampionRoles, ...league.rankRoles];
  if (mappings.length === 0) return 0;

  // ponytail: one REST fetch per linked player (~1k → under a minute); use GuildMembers intent + role.members if it grows.
  const players = await prisma.player.findMany({
    where: { gameId: league.gameId, discordId: { not: null } },
    select: { discordId: true },
  });
  const discordIds = [...new Set(players.map((p) => p.discordId!.trim()).filter(Boolean))];

  const guild = await client.guilds.fetch(league.guildId);
  let removed = 0;
  for (const discordId of discordIds) {
    const member = await guild.members.fetch(discordId).catch(() => null); // left the server
    if (!member) continue;
    for (const { discordRoleId, holderDiscordId } of mappings) {
      if (discordId === holderDiscordId || !member.roles.cache.has(discordRoleId)) continue;
      const context = { leagueId, discordId, reason: 'stray_role_sweep' };
      if (await tryRemoveRole(member, discordRoleId, context, 'Duplicate role cleanup'))
        removed += 1;
    }
  }
  return removed;
}

/** Staff reply for the hero/rank `cleanup` subcommands. */
export function sweepStrayCleanupReply(removed: number): string {
  return removed === 0
    ? 'No duplicate hero/rank roles found.'
    : `Removed ${removed} duplicate hero/rank role${removed === 1 ? '' : 's'}.`;
}
