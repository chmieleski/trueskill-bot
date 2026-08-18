import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  assertHostLobbyCapInTx,
  hostLobbyCapMessage,
  MatchServiceError,
} from './match-service.js';

function fakeTx(row: { id: string; status: 'PENDING' | 'IN_PROGRESS' } | null) {
  const findFirst = vi.fn().mockResolvedValue(row);
  return {
    tx: { match: { findFirst } } as unknown as Prisma.TransactionClient,
    findFirst,
  };
}

describe('hostLobbyCapMessage', () => {
  it('names a pending lobby and tells the host to cancel', () => {
    expect(hostLobbyCapMessage('PENDING', 'abc123')).toBe(
      'You already have a pending lobby (abc123). Cancel it before opening another.',
    );
  });

  it('names an in-progress match and tells the host to report or cancel', () => {
    expect(hostLobbyCapMessage('IN_PROGRESS', 'abc123')).toBe(
      'You already have a match in progress (abc123). Report or cancel it before opening another lobby.',
    );
  });
});

describe('assertHostLobbyCapInTx', () => {
  const base = { leagueId: 'league-1', hostDiscordId: 'host-1' };

  it('does not throw when there is no active hosted match', async () => {
    const { tx, findFirst } = fakeTx(null);
    await expect(assertHostLobbyCapInTx(tx, base)).resolves.toBeUndefined();
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        leagueId: 'league-1',
        hostDiscordId: 'host-1',
        status: { in: ['PENDING', 'IN_PROGRESS'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    });
  });

  it('throws the pending copy when a pending match exists', async () => {
    const { tx } = fakeTx({ id: 'match-p', status: 'PENDING' });
    await expect(assertHostLobbyCapInTx(tx, base)).rejects.toThrow(MatchServiceError);
    await expect(assertHostLobbyCapInTx(tx, base)).rejects.toThrow(
      hostLobbyCapMessage('PENDING', 'match-p'),
    );
  });

  it('throws the in-progress copy when an in-progress match exists', async () => {
    const { tx } = fakeTx({ id: 'match-i', status: 'IN_PROGRESS' });
    await expect(assertHostLobbyCapInTx(tx, base)).rejects.toThrow(
      hostLobbyCapMessage('IN_PROGRESS', 'match-i'),
    );
  });

  it('skips the query when bypassHostLobbyCap is true', async () => {
    const { tx, findFirst } = fakeTx({ id: 'match-p', status: 'PENDING' });
    await expect(
      assertHostLobbyCapInTx(tx, { ...base, bypassHostLobbyCap: true }),
    ).resolves.toBeUndefined();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('enforces the cap when bypassHostLobbyCap is omitted', async () => {
    const { tx } = fakeTx({ id: 'match-p', status: 'PENDING' });
    await expect(assertHostLobbyCapInTx(tx, base)).rejects.toThrow(
      hostLobbyCapMessage('PENDING', 'match-p'),
    );
  });
});
