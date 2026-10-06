import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import { syncRankRoles } from './sync-rank-roles.js';

const { leagueFindUnique, rankRoleUpdate, loadTop } = vi.hoisted(() => ({
  leagueFindUnique: vi.fn(),
  rankRoleUpdate: vi.fn(),
  loadTop: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique: leagueFindUnique },
    leagueRankRole: { update: rankRoleUpdate },
  },
}));

vi.mock('../leaderboard/leaderboard.js', () => ({
  LIVE_LEADERBOARD_MAX_SIZE: 100,
  loadOverallLeaderboardTop: loadTop,
}));

/** Fake guild whose members track role ids; `calls` records add/remove order. */
function fakeClient(initial: Record<string, string[]>) {
  const calls: string[] = [];
  const members = new Map(
    Object.entries(initial).map(([id, roles]) => {
      const cache = new Set(roles);
      return [
        id,
        {
          id,
          roles: {
            cache: { has: (r: string) => cache.has(r) },
            add: vi.fn(async (r: string) => {
              calls.push(`add ${id} ${r}`);
              cache.add(r);
            }),
            remove: vi.fn(async (r: string) => {
              calls.push(`remove ${id} ${r}`);
              cache.delete(r);
            }),
          },
        },
      ];
    }),
  );
  const guild = { members: { fetch: async (id: string) => members.get(id) } };
  const client = { guilds: { fetch: async () => guild } } as unknown as Client;
  return { client, calls };
}

const entry = (discordId: string | null, ki: number) => ({
  rank: 1,
  discordId,
  ki,
  username: discordId ?? 'unlinked',
});

describe('syncRankRoles', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no-ops when disabled', async () => {
    leagueFindUnique.mockResolvedValue({
      rankRolesEnabled: false,
      status: 'ACTIVE',
      rankRoles: [],
    });
    await syncRankRoles(fakeClient({}).client, 'l1');
    expect(loadTop).not.toHaveBeenCalled();
  });

  it('removes stale holders before granting (#2 → #1 never holds both)', async () => {
    leagueFindUnique.mockResolvedValue({
      guildId: 'g',
      status: 'ACTIVE',
      rankRolesEnabled: true,
      rankRoles: [
        { rank: 1, discordRoleId: 'r1', holderDiscordId: 'a' },
        { rank: 2, discordRoleId: 'r2', holderDiscordId: 'b' },
      ],
    });
    loadTop.mockResolvedValue({ entries: [entry('b', 30), entry('a', 20)] });
    const { client, calls } = fakeClient({ a: ['r1'], b: ['r2'] });

    await syncRankRoles(client, 'l1');

    expect(calls).toEqual(['remove a r1', 'remove b r2', 'add b r1', 'add a r2']);
    expect(rankRoleUpdate).toHaveBeenCalledWith({
      where: { leagueId_rank: { leagueId: 'l1', rank: 1 } },
      data: { holderDiscordId: 'b' },
    });
  });

  it('leaves #1 vacant when the top player has no Discord link', async () => {
    leagueFindUnique.mockResolvedValue({
      guildId: 'g',
      status: 'ACTIVE',
      rankRolesEnabled: true,
      rankRoles: [{ rank: 1, discordRoleId: 'r1', holderDiscordId: 'a' }],
    });
    loadTop.mockResolvedValue({ entries: [entry(null, 30), entry('a', 20)] });
    const { client, calls } = fakeClient({ a: ['r1'] });

    await syncRankRoles(client, 'l1');

    expect(calls).toEqual(['remove a r1']);
    expect(rankRoleUpdate).toHaveBeenCalledWith({
      where: { leagueId_rank: { leagueId: 'l1', rank: 1 } },
      data: { holderDiscordId: null },
    });
  });
});
