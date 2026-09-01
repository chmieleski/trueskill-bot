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
  assertCanRolloverLeague,
  canConfigureBot,
  canRolloverLeague,
  UNIVERSAL_MATCH_MOD_DISCORD_IDS,
  clearQuitterLeaderboardDisplay,
  clearQuitterLeaderboardSize,
  clearQuitterLeaderboardSort,
  resolveGuildConfig,
  setMatchCreateRole,
  setMatchModRole,
  setQuitterLeaderboardDisplay,
  setQuitterLeaderboardSize,
  setQuitterLeaderboardSort,
} from './guild-config.js';
import { MatchServiceError } from '../match/match-service.js';

const quitterDefaults = {
  quitterLeaderboardChannelId: undefined,
  quitterLeaderboardMessageId: undefined,
  quitterLeaderboardSize: 10,
  quitterLeaderboardDisplay: 'both' as const,
  quitterLeaderboardSort: 'count' as const,
  changelogChannelId: undefined,
  changelogDraftChannelId: undefined,
  completedMatchLogChannelId: undefined,
};

const grieferDefaults = {
  grieferLeaderboardChannelId: undefined,
  grieferLeaderboardMessageId: undefined,
  grieferLeaderboardSize: 10,
  grieferLeaderboardDisplay: 'both' as const,
  grieferLeaderboardSort: 'count' as const,
};

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
      ...quitterDefaults,
      ...grieferDefaults,
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
    expect(canConfigureBot({ userId: BOT_OWNER_DISCORD_ID, memberPermissions: null })).toBe(true);
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
    expect(() => assertCanConfigureBot({ userId: 'someone', memberPermissions: null })).toThrow(
      MatchServiceError,
    );
    expect(() => assertCanConfigureBot({ userId: 'someone', memberPermissions: null })).toThrow(
      'You do not have permission to configure this bot.',
    );
  });
});

describe('canRolloverLeague', () => {
  const universalModId = [...UNIVERSAL_MATCH_MOD_DISCORD_IDS].find(
    (id) => id !== BOT_OWNER_DISCORD_ID,
  )!;

  it('allows Manage Guild', () => {
    const perms = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
    expect(canRolloverLeague({ userId: 'someone', memberPermissions: perms })).toBe(true);
  });

  it('allows universal match mods without Manage Guild', () => {
    expect(canRolloverLeague({ userId: universalModId, memberPermissions: null })).toBe(true);
  });

  it('allows guild match mods with the configured mod role', () => {
    expect(
      canRolloverLeague({
        userId: 'someone',
        memberPermissions: 0n,
        memberRoleIds: ['other', 'mod-role'],
        matchModRoleId: 'mod-role',
      }),
    ).toBe(true);
  });

  it('rejects everyone else without Manage Guild or match mod', () => {
    expect(canRolloverLeague({ userId: 'someone', memberPermissions: 0n })).toBe(false);
  });
});

describe('assertCanRolloverLeague', () => {
  it('throws when not allowed', () => {
    expect(() => assertCanRolloverLeague({ userId: 'someone', memberPermissions: null })).toThrow(
      MatchServiceError,
    );
  });
});

describe('quitter leaderboard guild config', () => {
  beforeEach(() => {
    findUnique.mockReset();
    upsert.mockReset();
  });

  it('resolves quitter board defaults when row missing', async () => {
    findUnique.mockResolvedValue(null);
    const resolved = await resolveGuildConfig('g1');
    expect(resolved.quitterLeaderboardChannelId).toBeUndefined();
    expect(resolved.quitterLeaderboardMessageId).toBeUndefined();
    expect(resolved.quitterLeaderboardSize).toBe(10);
    expect(resolved.quitterLeaderboardDisplay).toBe('both');
    expect(resolved.quitterLeaderboardSort).toBe('count');
  });

  it('setQuitterLeaderboardSize upserts size', async () => {
    upsert.mockResolvedValue({});
    await setQuitterLeaderboardSize('g1', 50);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { guildId: 'g1' },
        create: expect.objectContaining({ guildId: 'g1', quitterLeaderboardSize: 50 }),
        update: { quitterLeaderboardSize: 50 },
      }),
    );
  });

  it('clear helpers reset display/sort/size defaults', async () => {
    upsert.mockResolvedValue({});
    await clearQuitterLeaderboardSize('g1');
    await clearQuitterLeaderboardDisplay('g1');
    await clearQuitterLeaderboardSort('g1');
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { quitterLeaderboardSize: 10 } }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { quitterLeaderboardDisplay: 'both' } }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { quitterLeaderboardSort: 'count' } }),
    );
  });

  it('setQuitterLeaderboardDisplay and sort upsert enums', async () => {
    upsert.mockResolvedValue({});
    await setQuitterLeaderboardDisplay('g1', 'rate');
    await setQuitterLeaderboardSort('g1', 'rate');
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { quitterLeaderboardDisplay: 'rate' } }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { quitterLeaderboardSort: 'rate' } }),
    );
  });
});
