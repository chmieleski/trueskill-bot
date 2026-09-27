import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiServerDeps } from './http-server.js';
import { handleApiRequest } from './http-server.js';

const { listWosHeroesForLeague, loadApiHeroCombatStats, loadApiMatchCombatStats } = vi.hoisted(
  () => ({
    listWosHeroesForLeague: vi.fn(),
    loadApiHeroCombatStats: vi.fn(),
    loadApiMatchCombatStats: vi.fn(),
  }),
);

vi.mock('../services/player/wos-hero-names.js', () => ({
  listWosHeroesForLeague: (...args: unknown[]) => listWosHeroesForLeague(...args),
}));

vi.mock('../services/player/api-hero-combat-stats.js', () => ({
  loadApiHeroCombatStats: (...args: unknown[]) => loadApiHeroCombatStats(...args),
  loadApiMatchCombatStats: (...args: unknown[]) => loadApiMatchCombatStats(...args),
}));

vi.mock('../services/match/match-waiting-approval.js', () => ({
  attachApprovalDiscordMessage: vi.fn(),
}));

type MockRes = ServerResponse & {
  statusCode: number;
  body: string;
  headers: Record<string, string | number | string[] | undefined>;
};

function createMockReq(init: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const req = Readable.from([Buffer.from('', 'utf8')]) as IncomingMessage;
  req.method = init.method ?? 'GET';
  req.url = init.url ?? '/v1/heroes';
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

const wosLeague = {
  leagueId: 'league-1',
  guildId: 'guild-1',
  gameId: 'warcraft3_wos',
  matchApprovalChannelId: 'chan-1',
  status: 'ACTIVE' as const,
};

const heroStatsBody = {
  leagueId: 'league-1',
  hero: { objectId: 101, name: 'Raiden Ei' },
  windows: {
    all: {
      games: 2,
      wins: 1,
      losses: 1,
      winRatePercent: 50,
      avgDamageTotal: 500,
      avgDamagePhys: 200,
      avgDamageMagic: 300,
      avgTakenTotal: 100,
      avgTakenPhys: 40,
      avgTakenMagic: 60,
      avgHeal: 10,
      avgKills: 2,
      avgDeaths: 1,
      sumDamageTotal: 1000,
      sumDamagePhys: 400,
      sumDamageMagic: 600,
      sumTakenTotal: 200,
      sumTakenPhys: 80,
      sumTakenMagic: 120,
      sumHeal: 20,
      sumKills: 4,
      sumDeaths: 2,
      kda: '2',
      topPlayers: [],
    },
  },
  recentGames: [],
};

const matchStatsBody = {
  matchId: 'match-1',
  leagueId: 'league-1',
  status: 'COMPLETED',
  externalId: 'ext-1',
  completedAt: '2026-01-10T12:00:00.000Z',
  players: [],
};

describe('WOS hero + match combat stats routes', () => {
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
    listWosHeroesForLeague.mockReset();
    loadApiHeroCombatStats.mockReset();
    loadApiMatchCombatStats.mockReset();
  });

  it('returns 401 without auth on GET /v1/heroes', async () => {
    const res = await runRequest(deps, { url: '/v1/heroes' });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
    expect(resolveToken).not.toHaveBeenCalled();
    expect(listWosHeroesForLeague).not.toHaveBeenCalled();
  });

  it('returns 403 when token resolves to a non-WOS game', async () => {
    resolveToken.mockResolvedValue({
      ...wosLeague,
      gameId: 'warcraft3_udbr',
    });

    const res = await runRequest(deps, {
      url: '/v1/heroes',
      headers: { authorization: 'Bearer secret-token' },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden' });
    expect(listWosHeroesForLeague).not.toHaveBeenCalled();
  });

  it('returns 400 on scope=range without from', async () => {
    resolveToken.mockResolvedValue(wosLeague);

    const res = await runRequest(deps, {
      url: '/v1/heroes/Raiden%20Ei/stats?scope=range',
      headers: { authorization: 'Bearer secret-token' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toEqual(expect.any(String));
    expect(loadApiHeroCombatStats).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid hero key encoding', async () => {
    resolveToken.mockResolvedValue(wosLeague);

    const res = await runRequest(deps, {
      url: '/v1/heroes/%E0%A4%A/stats',
      headers: { authorization: 'Bearer secret-token' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid hero key encoding.' });
    expect(loadApiHeroCombatStats).not.toHaveBeenCalled();
  });

  it('returns 404 when hero loader returns null', async () => {
    resolveToken.mockResolvedValue(wosLeague);
    loadApiHeroCombatStats.mockResolvedValue(null);

    const res = await runRequest(deps, {
      url: '/v1/heroes/Missing/stats',
      headers: { authorization: 'Bearer secret-token' },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not Found' });
    expect(loadApiHeroCombatStats).toHaveBeenCalledWith(
      expect.objectContaining({
        leagueId: 'league-1',
        gameId: 'warcraft3_wos',
        heroKey: 'Missing',
      }),
    );
  });

  it('returns 200 hero stats on the happy path (decoded hero key)', async () => {
    resolveToken.mockResolvedValue(wosLeague);
    loadApiHeroCombatStats.mockResolvedValue(heroStatsBody);

    const res = await runRequest(deps, {
      url: '/v1/heroes/Raiden%20Ei/stats',
      headers: { authorization: 'Bearer secret-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(heroStatsBody);
    expect(loadApiHeroCombatStats).toHaveBeenCalledWith({
      leagueId: 'league-1',
      gameId: 'warcraft3_wos',
      heroKey: 'Raiden Ei',
      query: expect.objectContaining({ scope: 'both', games: 20 }),
    });
  });

  it('returns 200 match stats on the happy path', async () => {
    resolveToken.mockResolvedValue(wosLeague);
    loadApiMatchCombatStats.mockResolvedValue(matchStatsBody);

    const res = await runRequest(deps, {
      url: '/v1/matches/match-1/stats',
      headers: { authorization: 'Bearer secret-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(matchStatsBody);
    expect(loadApiMatchCombatStats).toHaveBeenCalledWith({
      leagueId: 'league-1',
      gameId: 'warcraft3_wos',
      matchId: 'match-1',
    });
  });

  it('returns 404 when match is not in the league', async () => {
    resolveToken.mockResolvedValue(wosLeague);
    loadApiMatchCombatStats.mockResolvedValue(null);

    const res = await runRequest(deps, {
      url: '/v1/matches/wrong-league-match/stats',
      headers: { authorization: 'Bearer secret-token' },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not Found' });
  });
});
