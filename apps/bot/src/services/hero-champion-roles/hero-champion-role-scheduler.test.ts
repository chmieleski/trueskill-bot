import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import {
  runHeroChampionRoleSyncTick,
  startHeroChampionRoleScheduler,
  stopHeroChampionRoleScheduler,
} from './hero-champion-role-scheduler.js';

const { leagueFindMany, leagueUpdate, syncHeroChampionRolesMock } = vi.hoisted(() => ({
  leagueFindMany: vi.fn(),
  leagueUpdate: vi.fn(),
  syncHeroChampionRolesMock: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: {
      findMany: leagueFindMany,
      update: leagueUpdate,
    },
  },
}));

vi.mock('./sync-hero-champion-roles.js', () => ({
  syncHeroChampionRoles: syncHeroChampionRolesMock,
}));

describe('hero-champion-role-scheduler', () => {
  const fakeClient = {} as Client;

  beforeEach(() => {
    vi.clearAllMocks();
    stopHeroChampionRoleScheduler();
  });

  it('no-ops when no dirty active leagues exist', async () => {
    leagueFindMany.mockResolvedValue([]);

    const result = await runHeroChampionRoleSyncTick(fakeClient);

    expect(result).toEqual({ guildsProcessed: 0, leaguesSynced: 0, errors: 0 });
    expect(syncHeroChampionRolesMock).not.toHaveBeenCalled();
    expect(leagueUpdate).not.toHaveBeenCalled();
  });

  it('syncs dirty active leagues and resets dirty flag', async () => {
    leagueFindMany.mockResolvedValue([
      { id: 'league-1', guildId: 'guild-1', lastHeroChampionSyncAt: null },
      { id: 'league-2', guildId: 'guild-1', lastHeroChampionSyncAt: null },
    ]);
    syncHeroChampionRolesMock.mockResolvedValue(undefined);
    leagueUpdate.mockResolvedValue({});

    const result = await runHeroChampionRoleSyncTick(fakeClient);

    expect(result).toEqual({ guildsProcessed: 1, leaguesSynced: 2, errors: 0 });
    expect(syncHeroChampionRolesMock).toHaveBeenCalledTimes(2);
    expect(syncHeroChampionRolesMock).toHaveBeenCalledWith(fakeClient, 'league-1');
    expect(syncHeroChampionRolesMock).toHaveBeenCalledWith(fakeClient, 'league-2');

    expect(leagueUpdate).toHaveBeenCalledWith({
      where: { id: 'league-1' },
      data: {
        heroChampionRolesDirty: false,
        lastHeroChampionSyncAt: expect.any(Date),
      },
    });
    expect(leagueUpdate).toHaveBeenCalledWith({
      where: { id: 'league-2' },
      data: {
        heroChampionRolesDirty: false,
        lastHeroChampionSyncAt: expect.any(Date),
      },
    });
  });

  it('limits sync to maxGuilds option and prioritizes order returned by query', async () => {
    // 3 distinct guilds
    leagueFindMany.mockResolvedValue([
      { id: 'league-1', guildId: 'guild-1', lastHeroChampionSyncAt: new Date(1000) },
      { id: 'league-2', guildId: 'guild-2', lastHeroChampionSyncAt: new Date(2000) },
      { id: 'league-3', guildId: 'guild-3', lastHeroChampionSyncAt: new Date(3000) },
    ]);
    syncHeroChampionRolesMock.mockResolvedValue(undefined);
    leagueUpdate.mockResolvedValue({});

    // maxGuilds = 2
    const result = await runHeroChampionRoleSyncTick(fakeClient, { maxGuilds: 2 });

    expect(result).toEqual({ guildsProcessed: 2, leaguesSynced: 2, errors: 0 });
    expect(syncHeroChampionRolesMock).toHaveBeenCalledWith(fakeClient, 'league-1');
    expect(syncHeroChampionRolesMock).toHaveBeenCalledWith(fakeClient, 'league-2');
    expect(syncHeroChampionRolesMock).not.toHaveBeenCalledWith(fakeClient, 'league-3');
  });

  it('handles sync errors per league without aborting other leagues', async () => {
    leagueFindMany.mockResolvedValue([
      { id: 'league-fail', guildId: 'guild-1', lastHeroChampionSyncAt: null },
      { id: 'league-ok', guildId: 'guild-1', lastHeroChampionSyncAt: null },
    ]);
    syncHeroChampionRolesMock.mockImplementation(async (_client, leagueId) => {
      if (leagueId === 'league-fail') {
        throw new Error('Discord API unavailable');
      }
    });
    leagueUpdate.mockResolvedValue({});

    const result = await runHeroChampionRoleSyncTick(fakeClient);

    expect(result).toEqual({ guildsProcessed: 1, leaguesSynced: 1, errors: 1 });
    expect(leagueUpdate).toHaveBeenCalledTimes(1);
    expect(leagueUpdate).toHaveBeenCalledWith({
      where: { id: 'league-ok' },
      data: {
        heroChampionRolesDirty: false,
        lastHeroChampionSyncAt: expect.any(Date),
      },
    });
  });

  it('starts and stops scheduler intervals cleanly', () => {
    vi.useFakeTimers();
    try {
      startHeroChampionRoleScheduler(fakeClient);
      // Double call should be guarded
      startHeroChampionRoleScheduler(fakeClient);
      stopHeroChampionRoleScheduler();
    } finally {
      vi.useRealTimers();
    }
  });
});
