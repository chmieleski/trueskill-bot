import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  leagueFindUnique,
  leagueHeroChampionRoleUpdate,
  playerFindMany,
  loadEligibleHeroCandidates,
  getGameProfile,
} = vi.hoisted(() => ({
  playerFindMany: vi.fn(),
  leagueFindUnique: vi.fn(),
  leagueHeroChampionRoleUpdate: vi.fn(),
  loadEligibleHeroCandidates: vi.fn(),
  getGameProfile: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique: leagueFindUnique },
    leagueHeroChampionRole: { update: leagueHeroChampionRoleUpdate },
    player: { findMany: playerFindMany },
  },
}));

vi.mock('../../domain/game-profile.js', () => ({
  getGameProfile,
}));

vi.mock('./load-eligible-candidates.js', () => ({
  loadEligibleHeroCandidates,
}));

import { sweepStrayRoleHolders, syncHeroChampionRoles } from './sync-hero-champion-roles.js';

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

describe('sweepStrayRoleHolders', () => {
  const remove = vi.fn();
  const membersFetch = vi.fn();
  const client = {
    guilds: { fetch: vi.fn(async () => ({ members: { fetch: membersFetch } })) },
  } as never;

  function member(roleIds: string[]) {
    return { roles: { cache: { has: (r: string) => roleIds.includes(r) }, remove } };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    leagueFindUnique.mockResolvedValue({
      guildId: 'g1',
      gameId: 'game',
      heroChampionRoles: [{ discordRoleId: 'hero-role', holderDiscordId: 'holder' }],
      rankRoles: [{ discordRoleId: 'rank-role', holderDiscordId: 'other' }],
    });
    playerFindMany.mockResolvedValue([
      { discordId: 'holder' },
      { discordId: 'stale' },
      { discordId: 'left' },
    ]);
    membersFetch.mockImplementation(async (id: string) => {
      if (id === 'left') throw new Error('Unknown Member');
      return member(id === 'holder' ? ['hero-role', 'rank-role'] : ['hero-role']);
    });
  });

  it('strips hero and rank roles from everyone but the DB holder', async () => {
    await expect(sweepStrayRoleHolders(client, 'league-1')).resolves.toBe(2);

    // holder keeps hero-role but is not the rank holder; stale loses hero-role.
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith('rank-role', 'Duplicate role cleanup');
    expect(remove).toHaveBeenCalledWith('hero-role', 'Duplicate role cleanup');
  });
});
