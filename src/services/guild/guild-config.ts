import { PermissionFlagsBits, PermissionsBitField, type PermissionsString } from 'discord.js';
import {
  GrieferLeaderboardDisplay,
  GrieferLeaderboardSort,
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
 * Grants `/league rollover` in addition to match-mod operations (guild mod role or allowlist).
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

export const GRIEFER_LEADERBOARD_DEFAULT_SIZE = 10;
export const GRIEFER_LEADERBOARD_DEFAULT_DISPLAY = 'both' as const;
export const GRIEFER_LEADERBOARD_DEFAULT_SORT = 'count' as const;

export type GrieferLeaderboardDisplayValue = 'count' | 'rate' | 'both';
export type GrieferLeaderboardSortValue = 'count' | 'rate';

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
  grieferLeaderboardChannelId: string | undefined;
  grieferLeaderboardMessageId: string | undefined;
  grieferLeaderboardSize: number;
  grieferLeaderboardDisplay: GrieferLeaderboardDisplayValue;
  grieferLeaderboardSort: GrieferLeaderboardSortValue;
  changelogChannelId: string | undefined;
  changelogDraftChannelId: string | undefined;
  completedMatchLogChannelId: string | undefined;
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
    quitterLeaderboardSize: row?.quitterLeaderboardSize ?? QUITTER_LEADERBOARD_DEFAULT_SIZE,
    quitterLeaderboardDisplay:
      row?.quitterLeaderboardDisplay ?? QUITTER_LEADERBOARD_DEFAULT_DISPLAY,
    quitterLeaderboardSort: row?.quitterLeaderboardSort ?? QUITTER_LEADERBOARD_DEFAULT_SORT,
    grieferLeaderboardChannelId: trimOptionalId(row?.grieferLeaderboardChannelId),
    grieferLeaderboardMessageId: trimOptionalId(row?.grieferLeaderboardMessageId),
    grieferLeaderboardSize: row?.grieferLeaderboardSize ?? GRIEFER_LEADERBOARD_DEFAULT_SIZE,
    grieferLeaderboardDisplay:
      row?.grieferLeaderboardDisplay ?? GRIEFER_LEADERBOARD_DEFAULT_DISPLAY,
    grieferLeaderboardSort: row?.grieferLeaderboardSort ?? GRIEFER_LEADERBOARD_DEFAULT_SORT,
    changelogChannelId: trimOptionalId(row?.changelogChannelId),
    changelogDraftChannelId: trimOptionalId(row?.changelogDraftChannelId),
    completedMatchLogChannelId: trimOptionalId(row?.completedMatchLogChannelId),
  };
}

export async function setCompletedMatchLogChannel(
  guildId: string,
  channelId: string,
): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, completedMatchLogChannelId: channelId },
    update: { completedMatchLogChannelId: channelId },
  });
}

export async function clearCompletedMatchLogChannel(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId },
    update: { completedMatchLogChannelId: null },
  });
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

export async function setGrieferLeaderboardChannel(
  guildId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      grieferLeaderboardChannelId: channelId,
      grieferLeaderboardMessageId: messageId,
    },
    update: {
      grieferLeaderboardChannelId: channelId,
      grieferLeaderboardMessageId: messageId,
    },
  });
}

export async function clearGrieferLeaderboardChannel(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId },
    update: {
      grieferLeaderboardChannelId: null,
      grieferLeaderboardMessageId: null,
    },
  });
}

export async function setGrieferLeaderboardSize(guildId: string, size: number): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, grieferLeaderboardSize: size },
    update: { grieferLeaderboardSize: size },
  });
}

export async function clearGrieferLeaderboardSize(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, grieferLeaderboardSize: GRIEFER_LEADERBOARD_DEFAULT_SIZE },
    update: { grieferLeaderboardSize: GRIEFER_LEADERBOARD_DEFAULT_SIZE },
  });
}

export async function setGrieferLeaderboardDisplay(
  guildId: string,
  display: GrieferLeaderboardDisplayValue,
): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      grieferLeaderboardDisplay: display as GrieferLeaderboardDisplay,
    },
    update: { grieferLeaderboardDisplay: display as GrieferLeaderboardDisplay },
  });
}

export async function clearGrieferLeaderboardDisplay(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      grieferLeaderboardDisplay: GrieferLeaderboardDisplay.both,
    },
    update: { grieferLeaderboardDisplay: GrieferLeaderboardDisplay.both },
  });
}

export async function setGrieferLeaderboardSort(
  guildId: string,
  sort: GrieferLeaderboardSortValue,
): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      grieferLeaderboardSort: sort as GrieferLeaderboardSort,
    },
    update: { grieferLeaderboardSort: sort as GrieferLeaderboardSort },
  });
}

export async function clearGrieferLeaderboardSort(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      grieferLeaderboardSort: GrieferLeaderboardSort.count,
    },
    update: { grieferLeaderboardSort: GrieferLeaderboardSort.count },
  });
}

export function canConfigureBot(input: {
  userId: string;
  memberPermissions:
    PermissionsBitField | bigint | string | ReadonlyArray<PermissionsString> | null | undefined;
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
    PermissionsBitField | bigint | string | ReadonlyArray<PermissionsString> | null | undefined;
}): void {
  if (!canConfigureBot(input)) {
    throw new MatchServiceError(CONFIGURE_FORBIDDEN);
  }
}

/** True when the actor may run `/league rollover` (Manage Guild, bot owner, or match mod). */
export function canRolloverLeague(input: {
  userId: string;
  memberPermissions:
    PermissionsBitField | bigint | string | ReadonlyArray<PermissionsString> | null | undefined;
  memberRoleIds?: string[];
  matchModRoleId?: string;
}): boolean {
  if (canConfigureBot(input)) {
    return true;
  }

  if (isUniversalMatchMod(input.userId)) {
    return true;
  }

  const modRoleId = input.matchModRoleId;
  if (!modRoleId) {
    return false;
  }

  return input.memberRoleIds?.includes(modRoleId) ?? false;
}

export function assertCanRolloverLeague(input: Parameters<typeof canRolloverLeague>[0]): void {
  if (!canRolloverLeague(input)) {
    throw new MatchServiceError(CONFIGURE_FORBIDDEN);
  }
}
