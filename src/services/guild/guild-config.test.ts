import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique, upsert } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    guildConfig: {
      findUnique,
      upsert,
    },
  },
}));

vi.mock('../../config/env.js', () => ({
  env: {
    matchCreateRoleId: undefined as string | undefined,
    matchModRoleId: undefined as string | undefined,
  },
}));

import { env } from '../../config/env.js';
import {
  BOT_OWNER_DISCORD_ID,
  assertCanConfigureBot,
  canConfigureBot,
  resolveGuildConfig,
  setMatchCreateRole,
  setMatchModRole,
} from './guild-config.js';
import { MatchServiceError } from '../match/match-service.js';

describe('resolveGuildConfig', () => {
  beforeEach(() => {
    findUnique.mockReset();
    env.matchCreateRoleId = undefined;
    env.matchModRoleId = undefined;
  });

  it('uses env when no row exists', async () => {
    findUnique.mockResolvedValue(null);
    env.matchCreateRoleId = 'env-create';
    env.matchModRoleId = 'env-mod';

    const resolved = await resolveGuildConfig('guild-1');

    expect(resolved).toEqual({
      matchCreateRoleId: 'env-create',
      matchModRoleId: 'env-mod',
      matchCreateRoleSource: 'env',
      matchModRoleSource: 'env',
    });
  });

  it('uses database when fields are set and ignores env for those fields', async () => {
    findUnique.mockResolvedValue({
      guildId: 'guild-1',
      matchCreateRoleId: 'db-create',
      matchModRoleId: null,
    });
    env.matchCreateRoleId = 'env-create';
    env.matchModRoleId = 'env-mod';

    const resolved = await resolveGuildConfig('guild-1');

    expect(resolved.matchCreateRoleId).toBe('db-create');
    expect(resolved.matchCreateRoleSource).toBe('database');
    expect(resolved.matchModRoleId).toBe('env-mod');
    expect(resolved.matchModRoleSource).toBe('env');
  });

  it('reports unset when neither DB nor env provides a value', async () => {
    findUnique.mockResolvedValue(null);

    const resolved = await resolveGuildConfig('guild-1');

    expect(resolved.matchCreateRoleId).toBeUndefined();
    expect(resolved.matchCreateRoleSource).toBe('unset');
    expect(resolved.matchModRoleSource).toBe('unset');
  });
});

describe('setMatchCreateRole / setMatchModRole', () => {
  beforeEach(() => {
    upsert.mockReset();
    upsert.mockResolvedValue({});
  });

  it('upserts create role without clearing mod', async () => {
    await setMatchCreateRole('guild-1', 'role-create');

    expect(upsert).toHaveBeenCalledWith({
      where: { guildId: 'guild-1' },
      create: { guildId: 'guild-1', matchCreateRoleId: 'role-create' },
      update: { matchCreateRoleId: 'role-create' },
    });
  });

  it('upserts mod role without clearing create', async () => {
    await setMatchModRole('guild-1', 'role-mod');

    expect(upsert).toHaveBeenCalledWith({
      where: { guildId: 'guild-1' },
      create: { guildId: 'guild-1', matchModRoleId: 'role-mod' },
      update: { matchModRoleId: 'role-mod' },
    });
  });
});

describe('canConfigureBot', () => {
  it('allows the hard-coded owner without Manage Guild', () => {
    expect(
      canConfigureBot({ userId: BOT_OWNER_DISCORD_ID, memberPermissions: null }),
    ).toBe(true);
  });

  it('allows Manage Guild', () => {
    const perms = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
    expect(canConfigureBot({ userId: 'someone', memberPermissions: perms })).toBe(true);
  });

  it('rejects everyone else', () => {
    expect(canConfigureBot({ userId: 'someone', memberPermissions: 0n })).toBe(false);
  });
});

describe('assertCanConfigureBot', () => {
  it('throws when not allowed', () => {
    expect(() =>
      assertCanConfigureBot({ userId: 'someone', memberPermissions: null }),
    ).toThrow(MatchServiceError);
    expect(() =>
      assertCanConfigureBot({ userId: 'someone', memberPermissions: null }),
    ).toThrow('You do not have permission to configure this bot.');
  });
});
