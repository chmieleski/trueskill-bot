import {
  PermissionFlagsBits,
  PermissionsBitField,
  type PermissionsString,
} from 'discord.js';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { MatchServiceError } from '../match/match-service.js';

export const BOT_OWNER_DISCORD_ID = '723326675647070218';

const CONFIGURE_FORBIDDEN = 'You do not have permission to configure this bot.';

export type RoleConfigSource = 'database' | 'env' | 'unset';

/** Guild-level config: role overrides only. IHL fields live on League. */
export interface ResolvedGuildConfig {
  matchCreateRoleId: string | undefined;
  matchModRoleId: string | undefined;
  matchCreateRoleSource: RoleConfigSource;
  matchModRoleSource: RoleConfigSource;
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
