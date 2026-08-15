import {
  PermissionFlagsBits,
  PermissionsBitField,
  type PermissionsString,
} from 'discord.js';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { MatchServiceError } from '../match/match-service.js';
import {
  clearAllGuildWc3statsSlotMaps,
  parseWc3statsMapSha1,
  replaceGuildWc3statsSlotMaps,
  UDBR_MAP_PATTERN,
  UDBR_MAP_SHA1,
  UDBR_WC3STATS_SLOT_MAP,
} from '../wc3stats/wc3stats-slot-map.js';

export const BOT_OWNER_DISCORD_ID = '723326675647070218';

const CONFIGURE_FORBIDDEN = 'You do not have permission to configure this bot.';

export type RoleConfigSource = 'database' | 'env' | 'unset';

export interface ResolvedGuildConfig {
  matchCreateRoleId: string | undefined;
  matchModRoleId: string | undefined;
  matchCreateRoleSource: RoleConfigSource;
  matchModRoleSource: RoleConfigSource;
  leaderboardChannelId: string | undefined;
  leaderboardMessageId: string | undefined;
  lobbyPlayerClaimEnabled: boolean;
  wc3statsEnabled: boolean;
  wc3statsMapPattern: string | undefined;
  wc3statsMapSha1: string[];
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

export async function resolveGuildConfig(guildId: string): Promise<ResolvedGuildConfig> {
  const row = await prisma.guildConfig.findUnique({ where: { guildId } });

  const create = resolveField(row?.matchCreateRoleId, env.matchCreateRoleId);
  const mod = resolveField(row?.matchModRoleId, env.matchModRoleId);

  return {
    matchCreateRoleId: create.value,
    matchModRoleId: mod.value,
    matchCreateRoleSource: create.source,
    matchModRoleSource: mod.source,
    leaderboardChannelId: row?.leaderboardChannelId?.trim() || undefined,
    leaderboardMessageId: row?.leaderboardMessageId?.trim() || undefined,
    lobbyPlayerClaimEnabled: row?.lobbyPlayerClaimEnabled !== false,
    wc3statsEnabled: row?.wc3statsEnabled === true,
    wc3statsMapPattern: row?.wc3statsMapPattern?.trim() || undefined,
    wc3statsMapSha1: parseWc3statsMapSha1(row?.wc3statsMapSha1),
  };
}

export function isGuildWc3statsImportReady(
  resolved: Pick<ResolvedGuildConfig, 'wc3statsEnabled' | 'wc3statsMapPattern'>,
): boolean {
  return resolved.wc3statsEnabled && Boolean(resolved.wc3statsMapPattern);
}

export async function applyUdbrWc3statsPreset(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      wc3statsEnabled: true,
      wc3statsMapPattern: UDBR_MAP_PATTERN,
      wc3statsMapSha1: UDBR_MAP_SHA1,
    },
    update: {
      wc3statsEnabled: true,
      wc3statsMapPattern: UDBR_MAP_PATTERN,
      wc3statsMapSha1: UDBR_MAP_SHA1,
    },
  });
  await replaceGuildWc3statsSlotMaps(guildId, [...UDBR_WC3STATS_SLOT_MAP]);
}

export async function clearGuildWc3statsPackage(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      wc3statsEnabled: false,
      wc3statsMapPattern: null,
      wc3statsMapSha1: null,
    },
    update: {
      wc3statsEnabled: false,
      wc3statsMapPattern: null,
      wc3statsMapSha1: null,
    },
  });
  await clearAllGuildWc3statsSlotMaps(guildId);
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

export async function setLobbyPlayerClaimEnabled(
  guildId: string,
  enabled: boolean,
): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, lobbyPlayerClaimEnabled: enabled },
    update: { lobbyPlayerClaimEnabled: enabled },
  });
}

export async function setLeaderboardChannel(
  guildId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, leaderboardChannelId: channelId, leaderboardMessageId: messageId },
    update: { leaderboardChannelId: channelId, leaderboardMessageId: messageId },
  });
}

export async function clearLeaderboardChannel(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, leaderboardChannelId: null, leaderboardMessageId: null },
    update: { leaderboardChannelId: null, leaderboardMessageId: null },
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
