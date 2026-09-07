import { beforeEach, describe, expect, it, vi } from 'vitest';

const { update, findUnique } = vi.hoisted(() => ({
  update: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: {
      update,
      findUnique,
    },
  },
}));

import {
  createOrRotateLeagueApiToken,
  hashLeagueApiToken,
  resolveLeagueFromApiToken,
  revokeLeagueApiToken,
} from './league-api-token.js';

describe('hashLeagueApiToken', () => {
  it('is stable and hex length 64', () => {
    const a = hashLeagueApiToken('token-one');
    const b = hashLeagueApiToken('token-one');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createOrRotateLeagueApiToken', () => {
  beforeEach(() => {
    update.mockReset();
    update.mockResolvedValue({});
  });

  it('updates hash and returns plaintext ≠ hash', async () => {
    const result = await createOrRotateLeagueApiToken('league-1');

    expect(result.plaintext).toBeTruthy();
    expect(result.plaintext).not.toBe(hashLeagueApiToken(result.plaintext));
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'league-1' },
      data: {
        apiTokenHash: hashLeagueApiToken(result.plaintext),
        apiTokenCreatedAt: result.createdAt,
      },
    });
  });
});

describe('resolveLeagueFromApiToken', () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it('returns league for matching plaintext and null for wrong token', async () => {
    const plaintext = 'good-token';
    findUnique.mockResolvedValueOnce({
      id: 'league-1',
      guildId: 'guild-1',
      gameId: 'warcraft3_wos',
      matchApprovalChannelId: 'chan-1',
      status: 'ACTIVE',
    });

    const resolved = await resolveLeagueFromApiToken(plaintext);
    expect(findUnique).toHaveBeenCalledWith({
      where: { apiTokenHash: hashLeagueApiToken(plaintext) },
      select: {
        id: true,
        guildId: true,
        gameId: true,
        matchApprovalChannelId: true,
        status: true,
      },
    });
    expect(resolved).toEqual({
      leagueId: 'league-1',
      guildId: 'guild-1',
      gameId: 'warcraft3_wos',
      matchApprovalChannelId: 'chan-1',
      status: 'ACTIVE',
    });

    findUnique.mockResolvedValueOnce(null);
    expect(await resolveLeagueFromApiToken('wrong-token')).toBeNull();
  });

  it('returns null for empty plaintext without querying', async () => {
    expect(await resolveLeagueFromApiToken('')).toBeNull();
    expect(await resolveLeagueFromApiToken('   ')).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('revokeLeagueApiToken', () => {
  beforeEach(() => {
    update.mockReset();
    findUnique.mockReset();
    update.mockResolvedValue({});
  });

  it('clears hash; resolve then returns null', async () => {
    await revokeLeagueApiToken('league-1');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'league-1' },
      data: { apiTokenHash: null, apiTokenCreatedAt: null },
    });

    findUnique.mockResolvedValue(null);
    expect(await resolveLeagueFromApiToken('any-token')).toBeNull();
  });
});
