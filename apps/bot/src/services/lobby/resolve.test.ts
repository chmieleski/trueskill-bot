import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchServiceError } from '../match/match-service.js';

const { getMatchById, findPendingMatchesByHost } = vi.hoisted(() => ({
  getMatchById: vi.fn(),
  findPendingMatchesByHost: vi.fn(),
}));

vi.mock('../match/match-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../match/match-service.js')>();
  return {
    ...actual,
    getMatchById,
    findPendingMatchesByHost,
  };
});

import { resolvePendingMatchForManage } from './resolve.js';

function pendingMatch(
  overrides: {
    id?: string;
    hostDiscordId?: string;
    status?: string;
  } = {},
) {
  return {
    id: 'match-1',
    hostDiscordId: 'host-1',
    status: 'PENDING',
    players: [],
    ...overrides,
  };
}

describe('resolvePendingMatchForManage', () => {
  beforeEach(() => {
    getMatchById.mockReset();
    findPendingMatchesByHost.mockReset();
  });

  it('allows the host to resolve a pending match by id without a mod role', async () => {
    const match = pendingMatch();
    getMatchById.mockResolvedValue(match);

    const result = await resolvePendingMatchForManage({
      actorDiscordId: 'host-1',
      matchId: 'match-1',
      memberRoleIds: [],
    });

    expect(result.match).toEqual(match);
  });

  it("allows a match moderator to resolve someone else's pending match by id", async () => {
    const match = pendingMatch();
    getMatchById.mockResolvedValue(match);

    const result = await resolvePendingMatchForManage({
      actorDiscordId: 'mod-1',
      matchId: 'match-1',
      memberRoleIds: ['role-mod'],
      matchModRoleId: 'role-mod',
    });

    expect(result.match).toEqual(match);
  });

  it('rejects a non-host without the mod role', async () => {
    getMatchById.mockResolvedValue(pendingMatch());

    await expect(
      resolvePendingMatchForManage({
        actorDiscordId: 'other',
        matchId: 'match-1',
        memberRoleIds: [],
        matchModRoleId: 'role-mod',
      }),
    ).rejects.toThrow(MatchServiceError);

    await expect(
      resolvePendingMatchForManage({
        actorDiscordId: 'other',
        matchId: 'match-1',
        memberRoleIds: [],
        matchModRoleId: 'role-mod',
      }),
    ).rejects.toThrow('Only the match host or a match moderator can do that.');
  });

  it('rejects when the match is no longer pending', async () => {
    getMatchById.mockResolvedValue(pendingMatch({ status: 'IN_PROGRESS' }));

    await expect(
      resolvePendingMatchForManage({
        actorDiscordId: 'mod-1',
        matchId: 'match-1',
        memberRoleIds: ['role-mod'],
        matchModRoleId: 'role-mod',
      }),
    ).rejects.toThrow('This match can no longer be edited.');
  });

  it('asks a moderator to pass match_id when they have no pending lobby of their own', async () => {
    findPendingMatchesByHost.mockResolvedValue([]);

    await expect(
      resolvePendingMatchForManage({
        actorDiscordId: 'mod-1',
        memberRoleIds: ['role-mod'],
        matchModRoleId: 'role-mod',
      }),
    ).rejects.toThrow('Provide match_id when using the match moderator role.');
  });

  it("still finds the host's sole pending lobby without match_id", async () => {
    const match = pendingMatch();
    findPendingMatchesByHost.mockResolvedValue([match]);

    const result = await resolvePendingMatchForManage({
      actorDiscordId: 'host-1',
      memberRoleIds: [],
    });

    expect(result.match).toEqual(match);
  });
});
