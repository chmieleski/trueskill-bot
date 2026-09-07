import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchServiceError } from '../services/match/match-service.js';
import type { ApiServerDeps } from './http-server.js';
import { handleApiRequest } from './http-server.js';

type MockRes = ServerResponse & {
  statusCode: number;
  body: string;
  headers: Record<string, string | number | string[] | undefined>;
};

function createMockReq(init: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const req = Readable.from([Buffer.from(init.body ?? '', 'utf8')]) as IncomingMessage;
  req.method = init.method ?? 'POST';
  req.url = init.url ?? '/v1/matches/wos-report';
  req.headers = init.headers ?? {};
  return req;
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

async function runRequest(
  deps: ApiServerDeps,
  init: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<MockRes> {
  const req = createMockReq(init);
  const res = createMockRes();
  const done = new Promise<void>((resolve) => {
    res.once('finish', () => resolve());
  });
  await handleApiRequest(req, res, deps);
  await done;
  return res;
}

describe('handleApiRequest POST /v1/matches/wos-report', () => {
  const ingest = vi.fn();
  const resolveToken = vi.fn();
  const postApprovalMessage = vi.fn();

  const deps: ApiServerDeps = {
    ingest,
    resolveToken,
    postApprovalMessage,
    hostDiscordId: 'bot-user-1',
  };

  beforeEach(() => {
    ingest.mockReset();
    resolveToken.mockReset();
    postApprovalMessage.mockReset();
    postApprovalMessage.mockResolvedValue(null);
  });

  it('returns 401 when Authorization is missing', async () => {
    const res = await runRequest(deps, {
      body: JSON.stringify({ reportText: 'hello' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
    expect(resolveToken).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('returns 201 with ingest result shape on valid token', async () => {
    resolveToken.mockResolvedValue({
      leagueId: 'league-1',
      guildId: 'guild-1',
      gameId: 'warcraft3_wos',
      matchApprovalChannelId: 'chan-1',
      status: 'ACTIVE',
    });
    ingest.mockResolvedValue({
      matchId: 'match-1',
      status: 'WAITING_FOR_APPROVAL',
      externalId: 'ext-1',
      suggestedWinner: 2,
      discordMessageUrl: null,
    });

    const res = await runRequest(deps, {
      body: JSON.stringify({ reportText: 'raw report' }),
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json',
      },
    });

    expect(resolveToken).toHaveBeenCalledWith('secret-token');
    expect(ingest).toHaveBeenCalledWith({
      leagueId: 'league-1',
      guildId: 'guild-1',
      gameId: 'warcraft3_wos',
      matchApprovalChannelId: 'chan-1',
      hostDiscordId: 'bot-user-1',
      reportText: 'raw report',
    });
    expect(postApprovalMessage).toHaveBeenCalledWith({
      guildId: 'guild-1',
      channelId: 'chan-1',
      matchId: 'match-1',
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({
      matchId: 'match-1',
      status: 'WAITING_FOR_APPROVAL',
      externalId: 'ext-1',
      suggestedWinner: 2,
      discordMessageUrl: null,
    });
  });

  it('returns 409 when MatchServiceError mentions already uploaded', async () => {
    resolveToken.mockResolvedValue({
      leagueId: 'league-1',
      guildId: 'guild-1',
      gameId: 'warcraft3_wos',
      matchApprovalChannelId: 'chan-1',
      status: 'ACTIVE',
    });
    ingest.mockRejectedValue(
      new MatchServiceError('This match report (`ext`) was already uploaded for match `other`.'),
    );

    const res = await runRequest(deps, {
      body: JSON.stringify({ reportText: 'raw report' }),
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json',
      },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: 'This match report (`ext`) was already uploaded for match `other`.',
    });
  });

  it('returns 400 for bad JSON', async () => {
    resolveToken.mockResolvedValue({
      leagueId: 'league-1',
      guildId: 'guild-1',
      gameId: 'warcraft3_wos',
      matchApprovalChannelId: 'chan-1',
      status: 'ACTIVE',
    });

    const res = await runRequest(deps, {
      body: '{not-json',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toEqual(expect.any(String));
    expect(ingest).not.toHaveBeenCalled();
  });

  it('returns 201 with null discordMessageUrl when postApprovalMessage throws', async () => {
    resolveToken.mockResolvedValue({
      leagueId: 'league-1',
      guildId: 'guild-1',
      gameId: 'warcraft3_wos',
      matchApprovalChannelId: 'chan-1',
      status: 'ACTIVE',
    });
    ingest.mockResolvedValue({
      matchId: 'match-1',
      status: 'WAITING_FOR_APPROVAL',
      externalId: 'ext-1',
      suggestedWinner: 1,
      discordMessageUrl: null,
    });
    postApprovalMessage.mockRejectedValue(new Error('Discord channel missing'));

    const res = await runRequest(deps, {
      body: JSON.stringify({ reportText: 'raw report' }),
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({
      matchId: 'match-1',
      status: 'WAITING_FOR_APPROVAL',
      externalId: 'ext-1',
      suggestedWinner: 1,
      discordMessageUrl: null,
    });
  });
});
