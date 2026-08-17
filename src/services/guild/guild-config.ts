import {
  PermissionFlagsBits,
  PermissionsBitField,
  type PermissionsString,
} from 'discord.js';
import {
  QuitterLeaderboardDisplay,
  QuitterLeaderboardSort,
} from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { MatchServiceError } from '../match/match-service.js';

export const BOT_OWNER_DISCORD_ID = '723326675647070218';

/**
 * Discord IDs that always count as match moderators (no guild role required).
 * Does not grant `/config` — that remains bot owner or Manage Guild only.
 */
export const UNIVERSAL_MATCH_MOD_DISCORD_IDS = new Set<string>([
  BOT_OWNER_DISCORD_ID,
  '143479019097161728',
]);

/** True when the user is on the hard-coded universal match-mod allowlist. */
export function isUniversalMatchMod(discordId: string): boolean {
  return UNIVERSAL_MATCH_MOD_DISCORD_IDS.has(discordId);
}

const CONFIGURE_FORBIDDEN = 'You do not have permission to configure this bot.';

export const QUITTER_LEADERBOARD_DEFAULT_SIZE = 10;
export const QUITTER_LEADERBOARD_DEFAULT_DISPLAY = 'both' as const;
export const QUITTER_LEADERBOARD_DEFAULT_SORT = 'count' as const;

export type RoleConfigSource = 'database' | 'env' | 'unset';

export type QuitterLeaderboardDisplayValue = 'count' | 'rate' | 'both';
export type QuitterLeaderboardSortValue = 'count' | 'rate';

/** Guild-level config: role overrides only. IHL fields live on League. */
export interface ResolvedGuildConfig {
  matchCreateRoleId: string | undefined;
  matchModRoleId: string | undefined;
  matchCreateRoleSource: RoleConfigSource;
  matchModRoleSource: RoleConfigSource;
  quitterLeaderboardChannelId: string | undefined;
  quitterLeaderboardMessageId: string | undefined;
  quitterLeaderboardSize: number;
  quitterLeaderboardDisplay: QuitterLeaderboardDisplayValue;
  quitterLeaderboardSort: QuitterLeaderboardSortValue;
}

function resolveField(
  dbValue: string | null | undefined,
  envValue: string | undefined,
): { value: string | undefined; source: RoleConfigSource } {
  if (dbValue !== null && dbValue !== undefined && dbValue.trim() !== '') {
    return { value: dbValue.trim(), source: 'database' };
  }

  if (envValue !== undefined && envValue.trim() !== '') {
    return { value: envValue.trim(), source: 'env' };
  }

  return { value: undefined, source: 'unset' };
}

function trimOptionalId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export async function resolveGuildConfig(guildId: string): Promise<ResolvedGuildConfig> {
  const row = await prisma.guildConfig.findUnique({ where: { guildId } });

  const create = resolveField(row?.matchCreateRoleId, env.matchCreateRoleId);
  const mod = resolveField(row?.matchModRoleId, env.matchModRoleId);

  return {
    matchCreateRoleId: create.value,
    matchModRoleId: mod.value,
    matchCreateRoleSource: create.source,
    matchModRoleSource: mod.source,
    quitterLeaderboardChannelId: trimOptionalId(row?.quitterLeaderboardChannelId),
    quitterLeaderboardMessageId: trimOptionalId(row?.quitterLeaderboardMessageId),
    quitterLeaderboardSize:
      row?.quitterLeaderboardSize ?? QUITTER_LEADERBOARD_DEFAULT_SIZE,
    quitterLeaderboardDisplay:
      row?.quitterLeaderboardDisplay ?? QUITTER_LEADERBOARD_DEFAULT_DISPLAY,
    quitterLeaderboardSort:
      row?.quitterLeaderboardSort ?? QUITTER_LEADERBOARD_DEFAULT_SORT,
  };
}

export async function setMatchCreateRole(guildId: string, roleId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, matchCreateRoleId: roleId },
    update: { matchCreateRoleId: roleId },
  });
}

export async function setMatchModRole(guildId: string, roleId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, matchModRoleId: roleId },
    update: { matchModRoleId: roleId },
  });
}

export async function setQuitterLeaderboardChannel(
  guildId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      quitterLeaderboardChannelId: channelId,
      quitterLeaderboardMessageId: messageId,
    },
    update: {
      quitterLeaderboardChannelId: channelId,
      quitterLeaderboardMessageId: messageId,
    },
  });
}

export async function clearQuitterLeaderboardChannel(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId },
    update: {
      quitterLeaderboardChannelId: null,
      quitterLeaderboardMessageId: null,
    },
  });
}

export async function setQuitterLeaderboardSize(guildId: string, size: number): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, quitterLeaderboardSize: size },
    update: { quitterLeaderboardSize: size },
  });
}

export async function clearQuitterLeaderboardSize(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, quitterLeaderboardSize: QUITTER_LEADERBOARD_DEFAULT_SIZE },
    update: { quitterLeaderboardSize: QUITTER_LEADERBOARD_DEFAULT_SIZE },
  });
}

export async function setQuitterLeaderboardDisplay(
  guildId: string,
  display: QuitterLeaderboardDisplayValue,
): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      quitterLeaderboardDisplay: display as QuitterLeaderboardDisplay,
    },
    update: { quitterLeaderboardDisplay: display as QuitterLeaderboardDisplay },
  });
}

export async function clearQuitterLeaderboardDisplay(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      quitterLeaderboardDisplay: QuitterLeaderboardDisplay.both,
    },
    update: { quitterLeaderboardDisplay: QuitterLeaderboardDisplay.both },
  });
}

export async function setQuitterLeaderboardSort(
  guildId: string,
  sort: QuitterLeaderboardSortValue,
): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      quitterLeaderboardSort: sort as QuitterLeaderboardSort,
    },
    update: { quitterLeaderboardSort: sort as QuitterLeaderboardSort },
  });
}

export async function clearQuitterLeaderboardSort(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      quitterLeaderboardSort: QuitterLeaderboardSort.count,
    },
    update: { quitterLeaderboardSort: QuitterLeaderboardSort.count },
  });
}

export function canConfigureBot(input: {
  userId: string;
  memberPermissions:
    | PermissionsBitField
    | bigint
    | string
    | ReadonlyArray<PermissionsString>
    | null
    | undefined;
}): boolean {
  if (input.userId === BOT_OWNER_DISCORD_ID) {
    return true;
  }

  if (input.memberPermissions == null) {
    return false;
  }

  const bitfield = new PermissionsBitField(input.memberPermissions as never);
  return bitfield.has(PermissionFlagsBits.ManageGuild);
}

export function assertCanConfigureBot(input: {
  userId: string;
  memberPermissions:
    | PermissionsBitField
    | bigint
    | string
    | ReadonlyArray<PermissionsString>
    | null
    | undefined;
}): void {
  if (!canConfigureBot(input)) {
    throw new MatchServiceError(CONFIGURE_FORBIDDEN);
  }
}
