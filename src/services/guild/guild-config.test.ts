import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique, upsert } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));

const { replaceGuildWc3statsSlotMaps, clearAllGuildWc3statsSlotMaps } = vi.hoisted(() => ({
  replaceGuildWc3statsSlotMaps: vi.fn(),
  clearAllGuildWc3statsSlotMaps: vi.fn(),
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

vi.mock('../wc3stats/wc3stats-slot-map.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wc3stats/wc3stats-slot-map.js')>();
  return {
    ...actual,
    replaceGuildWc3statsSlotMaps,
    clearAllGuildWc3statsSlotMaps,
  };
});

import { env } from '../../config/env.js';
import {
  BOT_OWNER_DISCORD_ID,
  applyUdbrWc3statsPreset,
  assertCanConfigureBot,
  canConfigureBot,
  clearLeaderboardChannel,
  clearGuildWc3statsPackage,
  isGuildWc3statsImportReady,
  resolveGuildConfig,
  setLeaderboardChannel,
  setLobbyPlayerClaimEnabled,
  setMatchCreateRole,
  setMatchModRole,
} from './guild-config.js';
import { MatchServiceError } from '../match/match-service.js';
import {
  UDBR_MAP_PATTERN,
  UDBR_MAP_SHA1,
  UDBR_WC3STATS_SLOT_MAP,
} from '../wc3stats/wc3stats-slot-map.js';

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
      leaderboardChannelId: undefined,
      leaderboardMessageId: undefined,
      lobbyPlayerClaimEnabled: true,
      wc3statsEnabled: false,
      wc3statsMapPattern: undefined,
      wc3statsMapSha1: [],
    });
  });

  it('defaults player claim to on when no guild row exists', async () => {
    findUnique.mockResolvedValue(null);
    const resolved = await resolveGuildConfig('guild-1');
    expect(resolved.lobbyPlayerClaimEnabled).toBe(true);
  });

  it('returns false when the guild disabled player claim', async () => {
    findUnique.mockResolvedValue({
      guildId: 'guild-1',
      matchCreateRoleId: null,
      matchModRoleId: null,
      leaderboardChannelId: null,
      leaderboardMessageId: null,
      lobbyPlayerClaimEnabled: false,
    });
    const resolved = await resolveGuildConfig('guild-1');
    expect(resolved.lobbyPlayerClaimEnabled).toBe(false);
  });

  it('uses database when fields are set and ignores env for those fields', async () => {
    findUnique.mockResolvedValue({
      guildId: 'guild-1',
      matchCreateRoleId: 'db-create',
      matchModRoleId: null,
      leaderboardChannelId: 'chan-1',
      leaderboardMessageId: 'msg-1',
    });
    env.matchCreateRoleId = 'env-create';
    env.matchModRoleId = 'env-mod';

    const resolved = await resolveGuildConfig('guild-1');

    expect(resolved.matchCreateRoleId).toBe('db-create');
    expect(resolved.matchCreateRoleSource).toBe('database');
    expect(resolved.matchModRoleId).toBe('env-mod');
    expect(resolved.matchModRoleSource).toBe('env');
    expect(resolved.leaderboardChannelId).toBe('chan-1');
    expect(resolved.leaderboardMessageId).toBe('msg-1');
    expect(resolved.lobbyPlayerClaimEnabled).toBe(true);
  });

  it('reports unset when neither DB nor env provides a value', async () => {
    findUnique.mockResolvedValue(null);

    const resolved = await resolveGuildConfig('guild-1');

    expect(resolved.matchCreateRoleId).toBeUndefined();
    expect(resolved.matchCreateRoleSource).toBe('unset');
    expect(resolved.matchModRoleSource).toBe('unset');
  });
});

describe('guild wc3stats package', () => {
  beforeEach(() => {
    findUnique.mockReset();
    upsert.mockReset();
    replaceGuildWc3statsSlotMaps.mockReset();
    clearAllGuildWc3statsSlotMaps.mockReset();
    upsert.mockResolvedValue({});
  });

  it('defaults wc3stats off with empty filter when no row', async () => {
    findUnique.mockResolvedValue(null);
    const resolved = await resolveGuildConfig('guild-1');
    expect(resolved.wc3statsEnabled).toBe(false);
    expect(resolved.wc3statsMapPattern).toBeUndefined();
    expect(resolved.wc3statsMapSha1).toEqual([]);
  });

  it('reads enabled and filter from the database only', async () => {
    findUnique.mockResolvedValue({
      guildId: 'guild-1',
      matchCreateRoleId: null,
      matchModRoleId: null,
      leaderboardChannelId: null,
      leaderboardMessageId: null,
      lobbyPlayerClaimEnabled: true,
      wc3statsEnabled: true,
      wc3statsMapPattern: 'udbr',
      wc3statsMapSha1: 'Aa, Bb',
    });
    const resolved = await resolveGuildConfig('guild-1');
    expect(resolved.wc3statsEnabled).toBe(true);
    expect(resolved.wc3statsMapPattern).toBe('udbr');
    expect(resolved.wc3statsMapSha1).toEqual(['aa', 'bb']);
  });

  it('isGuildWc3statsImportReady requires enabled and pattern', () => {
    expect(
      isGuildWc3statsImportReady({
        wc3statsEnabled: true,
        wc3statsMapPattern: 'x',
      }),
    ).toBe(true);
    expect(
      isGuildWc3statsImportReady({
        wc3statsEnabled: true,
        wc3statsMapPattern: undefined,
      }),
    ).toBe(false);
    expect(
      isGuildWc3statsImportReady({
        wc3statsEnabled: false,
        wc3statsMapPattern: 'x',
      }),
    ).toBe(false);
  });

  it('applies the UDBR wc3stats preset package', async () => {
    await applyUdbrWc3statsPreset('guild-1');

    expect(upsert).toHaveBeenCalledWith({
      where: { guildId: 'guild-1' },
      create: {
        guildId: 'guild-1',
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
    expect(replaceGuildWc3statsSlotMaps).toHaveBeenCalledWith('guild-1', [
      ...UDBR_WC3STATS_SLOT_MAP,
    ]);
  });

  it('clears the guild wc3stats package', async () => {
    await clearGuildWc3statsPackage('guild-1');

    expect(upsert).toHaveBeenCalledWith({
      where: { guildId: 'guild-1' },
      create: {
        guildId: 'guild-1',
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
    expect(clearAllGuildWc3statsSlotMaps).toHaveBeenCalledWith('guild-1');
  });
});

describe('leaderboard channel config', () => {
  beforeEach(() => {
    upsert.mockReset();
    upsert.mockResolvedValue({});
  });

  it('upserts leaderboard channel and message ids', async () => {
    await setLeaderboardChannel('guild-1', 'chan-1', 'msg-1');

    expect(upsert).toHaveBeenCalledWith({
      where: { guildId: 'guild-1' },
      create: {
        guildId: 'guild-1',
        leaderboardChannelId: 'chan-1',
        leaderboardMessageId: 'msg-1',
      },
      update: {
        leaderboardChannelId: 'chan-1',
        leaderboardMessageId: 'msg-1',
      },
    });
  });

  it('clears leaderboard ids', async () => {
    await clearLeaderboardChannel('guild-1');

    expect(upsert).toHaveBeenCalledWith({
      where: { guildId: 'guild-1' },
      create: {
        guildId: 'guild-1',
        leaderboardChannelId: null,
        leaderboardMessageId: null,
      },
      update: {
        leaderboardChannelId: null,
        leaderboardMessageId: null,
      },
    });
  });
});

describe('setLobbyPlayerClaimEnabled', () => {
  beforeEach(() => {
    upsert.mockReset();
    upsert.mockResolvedValue({});
  });

  it('upserts the player claim flag without clearing other fields', async () => {
    await setLobbyPlayerClaimEnabled('guild-1', false);

    expect(upsert).toHaveBeenCalledWith({
      where: { guildId: 'guild-1' },
      create: { guildId: 'guild-1', lobbyPlayerClaimEnabled: false },
      update: { lobbyPlayerClaimEnabled: false },
    });
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
