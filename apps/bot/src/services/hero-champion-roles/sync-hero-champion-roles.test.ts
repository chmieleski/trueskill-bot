import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  leagueFindUnique,
  leagueHeroChampionRoleUpdate,
  loadEligibleHeroCandidates,
  getGameProfile,
} = vi.hoisted(() => ({
  leagueFindUnique: vi.fn(),
  leagueHeroChampionRoleUpdate: vi.fn(),
  loadEligibleHeroCandidates: vi.fn(),
  getGameProfile: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique: leagueFindUnique },
    leagueHeroChampionRole: { update: leagueHeroChampionRoleUpdate },
  },
}));

vi.mock('../../domain/game-profile.js', () => ({
  getGameProfile,
}));

vi.mock('./load-eligible-candidates.js', () => ({
  loadEligibleHeroCandidates,
}));

import {
  sweepHeroChampionDiscordRoles,
  syncHeroChampionRoles,
} from './sync-hero-champion-roles.js';

describe('syncHeroChampionRoles', () => {
  const add = vi.fn();
  const remove = vi.fn();
  const membersFetch = vi.fn();
  const guildsFetch = vi.fn();

  const client = {
    guilds: { fetch: guildsFetch },
  } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    getGameProfile.mockReturnValue({ heroChampionRoles: true });
    guildsFetch.mockResolvedValue({
      members: { fetch: membersFetch },
    });
    membersFetch.mockImplementation(async (id: string) => ({
      id,
      roles: {
        cache: { has: () => false },
        add,
        remove,
      },
    }));
  });

  it('no-ops when disabled', async () => {
    leagueFindUnique.mockResolvedValue({
      guildId: 'g1',
      gameId: 'warcraft3_udbr',
      status: 'ACTIVE',
      heroChampionRolesEnabled: false,
      heroChampionRoles: [],
    });

    await syncHeroChampionRoles(client, 'league-1');
    expect(loadEligibleHeroCandidates).not.toHaveBeenCalled();
  });

  it('no-ops when league is archived', async () => {
    leagueFindUnique.mockResolvedValue({
      guildId: 'g1',
      gameId: 'warcraft3_udbr',
      status: 'ARCHIVED',
      heroChampionRolesEnabled: true,
      heroChampionRoles: [{ heroId: 1, discordRoleId: 'role-1', holderDiscordId: 'old' }],
    });

    await syncHeroChampionRoles(client, 'league-1');
    expect(loadEligibleHeroCandidates).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('assigns role to the top candidate and persists holder', async () => {
    leagueFindUnique.mockResolvedValue({
      guildId: 'g1',
      gameId: 'warcraft3_udbr',
      status: 'ACTIVE',
      heroChampionRolesEnabled: true,
      heroChampionRoles: [{ heroId: 1, discordRoleId: 'role-1', holderDiscordId: null }],
    });
    loadEligibleHeroCandidates.mockResolvedValue([
      { discordId: 'champ', ki: 6000, username: 'champ' },
    ]);

    await syncHeroChampionRoles(client, 'league-1');

    expect(add).toHaveBeenCalledWith('role-1', 'Hero champion role sync');
    expect(leagueHeroChampionRoleUpdate).toHaveBeenCalledWith({
      where: { leagueId_heroId: { leagueId: 'league-1', heroId: 1 } },
      data: { holderDiscordId: 'champ' },
    });
  });

  it('removes previous holder and does not throw when Discord add fails', async () => {
    leagueFindUnique.mockResolvedValue({
      guildId: 'g1',
      gameId: 'warcraft3_udbr',
      status: 'ACTIVE',
      heroChampionRolesEnabled: true,
      heroChampionRoles: [{ heroId: 1, discordRoleId: 'role-1', holderDiscordId: 'old' }],
    });
    loadEligibleHeroCandidates.mockResolvedValue([{ discordId: 'new', ki: 7000, username: 'new' }]);
    membersFetch.mockImplementation(async (id: string) => ({
      id,
      roles: {
        cache: {
          has: (roleId: string) => id === 'old' && roleId === 'role-1',
        },
        add,
        remove,
      },
    }));
    add.mockRejectedValueOnce(new Error('Missing Permissions'));

    await expect(syncHeroChampionRoles(client, 'league-1')).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalled();
    expect(leagueHeroChampionRoleUpdate).toHaveBeenCalledWith({
      where: { leagueId_heroId: { leagueId: 'league-1', heroId: 1 } },
      data: { holderDiscordId: 'new' },
    });
  });
});

describe('sweepHeroChampionDiscordRoles', () => {
  const add = vi.fn(async function add(this: { cache: Map<string, true> }, roleId: string) {
    this.cache.set(roleId, true);
  });
  const remove = vi.fn(async function remove(this: { cache: Map<string, true> }, roleId: string) {
    this.cache.delete(roleId);
  });

  function member(id: string, roleIds: string[]) {
    const cache = new Map(roleIds.map((r) => [r, true] as const));
    return {
      id,
      roles: {
        cache: {
          has: (roleId: string) => cache.has(roleId),
        },
        add: add.bind({ cache }),
        remove: remove.bind({ cache }),
      },
    };
  }

  const members = new Map([
    ['holder', member('holder', [])],
    ['stale', member('stale', ['role-1'])],
  ]);

  const guildsFetch = vi.fn();
  const client = { guilds: { fetch: guildsFetch } } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    members.set('holder', member('holder', []));
    members.set('stale', member('stale', ['role-1']));
    guildsFetch.mockResolvedValue({
      members: {
        fetch: vi.fn().mockResolvedValue(undefined),
        cache: {
          values: () => members.values(),
          get: (id: string) => members.get(id),
        },
      },
    });
  });

  it('removes stale role holders and ensures the DB holder', async () => {
    leagueFindUnique.mockResolvedValue({
      guildId: 'g1',
      status: 'ACTIVE',
      heroChampionRolesEnabled: true,
      heroChampionRoles: [{ heroId: 1, discordRoleId: 'role-1', holderDiscordId: 'holder' }],
    });

    const result = await sweepHeroChampionDiscordRoles(client, 'league-1');

    expect(remove).toHaveBeenCalled();
    expect(add).toHaveBeenCalled();
    expect(result.removed).toBe(1);
    expect(result.ensured).toBe(1);
  });
});
