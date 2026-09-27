import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WARCRAFT3_UDBR_GAME_ID, WARCRAFT3_WOS_GAME_ID } from '../domain/games.js';
import type { LeagueApiTokenResolved } from '../services/league/league-api-token.js';
import { requireLeagueApiAuth } from './league-auth.js';

type MockRes = ServerResponse & {
  statusCode: number;
  body: string;
  headers: Record<string, string | number | string[] | undefined>;
};

function createMockReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

function createMockRes(): MockRes {
  const res = new EventEmitter() as MockRes;
  res.statusCode = 200;
  res.body = '';
  res.headers = {};
  res.setHeader = ((name: string, value: string | number | readonly string[]) => {
    res.headers[name.toLowerCase()] = value as string | number | string[];
    return res;
  }) as ServerResponse['setHeader'];
  res.end = ((chunk?: unknown) => {
    if (chunk !== undefined && chunk !== null) {
      res.body =
        typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : String(chunk);
    }
    res.emit('finish');
    return res;
  }) as ServerResponse['end'];
  return res;
}

async function runAuth(
  init: {
    headers?: Record<string, string>;
    requireWos: boolean;
  },
  resolveToken: (plaintext: string) => Promise<LeagueApiTokenResolved | null>,
): Promise<{ result: Awaited<ReturnType<typeof requireLeagueApiAuth>>; res: MockRes }> {
  const req = createMockReq(init.headers);
  const res = createMockRes();
  const done = new Promise<void>((resolve) => {
    res.once('finish', () => resolve());
  });
  const result = await requireLeagueApiAuth(req, res, resolveToken, {
    requireWos: init.requireWos,
  });
  if (res.body !== '') {
    await done;
  }
  return { result, res };
}

const activeLeague = (gameId: string): LeagueApiTokenResolved => ({
  leagueId: 'league-1',
  guildId: 'guild-1',
  gameId,
  matchApprovalChannelId: 'chan-1',
  status: 'ACTIVE',
});

describe('requireLeagueApiAuth', () => {
  const resolveToken = vi.fn<(plaintext: string) => Promise<LeagueApiTokenResolved | null>>();

  beforeEach(() => {
    resolveToken.mockReset();
  });

  it('returns 401 when Authorization is missing', async () => {
    const { result, res } = await runAuth({ requireWos: true }, resolveToken);

    expect(result).toEqual({ ok: false });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it('returns 401 when token does not resolve', async () => {
    resolveToken.mockResolvedValue(null);

    const { result, res } = await runAuth(
      { headers: { authorization: 'Bearer bad-token' }, requireWos: true },
      resolveToken,
    );

    expect(result).toEqual({ ok: false });
    expect(resolveToken).toHaveBeenCalledWith('bad-token');
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
  });

  it('returns 403 for UDBR league when requireWos is true', async () => {
    resolveToken.mockResolvedValue(activeLeague(WARCRAFT3_UDBR_GAME_ID));

    const { result, res } = await runAuth(
      { headers: { authorization: 'Bearer secret' }, requireWos: true },
      resolveToken,
    );

    expect(result).toEqual({ ok: false });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden' });
  });

  it('returns league for WOS when requireWos is true', async () => {
    const league = activeLeague(WARCRAFT3_WOS_GAME_ID);
    resolveToken.mockResolvedValue(league);

    const { result, res } = await runAuth(
      { headers: { authorization: 'Bearer secret' }, requireWos: true },
      resolveToken,
    );

    expect(result).toEqual({ ok: true, league });
    expect(res.body).toBe('');
    expect(res.statusCode).toBe(200);
  });
});
