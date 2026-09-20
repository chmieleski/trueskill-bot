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
      heroChampionRolesEnabled: true,
      heroChampionRoles: true,
    },
  });

  if (!league?.heroChampionRolesEnabled) {
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
