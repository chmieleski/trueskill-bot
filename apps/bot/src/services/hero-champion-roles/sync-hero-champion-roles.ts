import type { Client, GuildMember } from 'discord.js';
import { getGameProfile } from '../../domain/game-profile.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { loadEligibleHeroCandidates } from './load-eligible-candidates.js';
import { pickHeroChampion } from './pick-hero-champion.js';

const log = createLogger('hero_champion_roles');

async function tryRemoveRole(
  member: GuildMember | null,
  roleId: string,
  context: Record<string, unknown>,
): Promise<void> {
  if (!member?.roles.cache.has(roleId)) {
    return;
  }
  try {
    await member.roles.remove(roleId, 'Hero champion role sync');
  } catch (error) {
    log.warn({ err: error, ...context }, 'Failed to remove hero champion role');
  }
}

async function tryAddRole(
  member: GuildMember | null,
  roleId: string,
  context: Record<string, unknown>,
): Promise<void> {
  if (!member || member.roles.cache.has(roleId)) {
    return;
  }
  try {
    await member.roles.add(roleId, 'Hero champion role sync');
  } catch (error) {
    log.warn({ err: error, ...context }, 'Failed to add hero champion role');
  }
}

async function fetchMemberBestEffort(
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

export type HeroChampionSweepResult = {
  removed: number;
  ensured: number;
};

/**
 * After holders are synced: strip the champion Discord role from anyone who is
 * not the current DB holder, then ensure the holder has the role.
 * Requires GuildMembers intent so the guild member cache can be filled.
 */
export async function sweepHeroChampionDiscordRoles(
  client: Client,
  leagueId: string,
): Promise<HeroChampionSweepResult> {
  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    select: {
      guildId: true,
      status: true,
      heroChampionRolesEnabled: true,
      heroChampionRoles: {
        select: { heroId: true, discordRoleId: true, holderDiscordId: true },
      },
    },
  });

  if (!league?.heroChampionRolesEnabled || league.status === 'ARCHIVED') {
    return { removed: 0, ensured: 0 };
  }

  if (league.heroChampionRoles.length === 0) {
    return { removed: 0, ensured: 0 };
  }

  let guild;
  try {
    guild = await client.guilds.fetch(league.guildId);
    await guild.members.fetch();
  } catch (error) {
    log.warn(
      { err: error, leagueId, guildId: league.guildId },
      'Failed to fetch guild members for champion role sweep',
    );
    return { removed: 0, ensured: 0 };
  }

  let removed = 0;
  let ensured = 0;

  for (const mapping of league.heroChampionRoles) {
    const withRole = [...guild.members.cache.values()].filter((member) =>
      member.roles.cache.has(mapping.discordRoleId),
    );

    for (const member of withRole) {
      if (member.id === mapping.holderDiscordId) {
        continue;
      }
      const hadRole = member.roles.cache.has(mapping.discordRoleId);
      await tryRemoveRole(member, mapping.discordRoleId, {
        leagueId,
        heroId: mapping.heroId,
        discordId: member.id,
        reason: 'champion_role_sweep',
      });
      if (hadRole && !member.roles.cache.has(mapping.discordRoleId)) {
        removed += 1;
      }
    }

    if (!mapping.holderDiscordId) {
      continue;
    }

    const holder =
      guild.members.cache.get(mapping.holderDiscordId) ??
      (await fetchMemberBestEffort(client, league.guildId, mapping.holderDiscordId));
    await tryAddRole(holder, mapping.discordRoleId, {
      leagueId,
      heroId: mapping.heroId,
      discordId: mapping.holderDiscordId,
    });
    if (holder?.roles.cache.has(mapping.discordRoleId)) {
      ensured += 1;
    }
  }

  return { removed, ensured };
}
