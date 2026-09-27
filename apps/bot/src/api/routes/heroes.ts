import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../../lib/logger.js';
import { loadApiHeroCombatStats } from '../../services/player/api-hero-combat-stats.js';
import { listWosHeroesForLeague } from '../../services/player/wos-hero-names.js';
import { sendJson } from '../http-io.js';
import type { ApiServerDeps } from '../http-server.js';
import { requireLeagueApiAuth } from '../league-auth.js';
import { parseApiHeroStatsQuery } from '../parse-query.js';

const log = createLogger('api-heroes');

const HEROES_LIST_PATH = '/v1/heroes';
const HERO_STATS_PATH = /^\/v1\/heroes\/([^/]+)\/stats$/;

/**
 * Handle `GET /v1/heroes` and `GET /v1/heroes/:heroKey/stats`.
 * Returns true when the path matched (including wrong method → 404 for this path).
 */
export async function handleHeroesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
): Promise<boolean> {
  const rawUrl = req.url ?? '';
  const qIndex = rawUrl.indexOf('?');
  const pathname = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  const searchParams = new URLSearchParams(qIndex === -1 ? '' : rawUrl.slice(qIndex + 1));

  if (pathname === HEROES_LIST_PATH) {
    if (req.method !== 'GET') {
      sendJson(res, 404, { error: 'Not Found' });
      return true;
    }

    const auth = await requireLeagueApiAuth(req, res, deps.resolveToken, { requireWos: true });
    if (!auth.ok) {
      return true;
    }
    const { league } = auth;

    try {
      const heroes = await listWosHeroesForLeague(league.leagueId, league.gameId);
      sendJson(res, 200, { leagueId: league.leagueId, heroes });
    } catch (error) {
      log.error({ err: error }, 'Unexpected error listing WOS heroes');
      sendJson(res, 500, { error: 'Internal Server Error' });
    }
    return true;
  }

  const statsMatch = HERO_STATS_PATH.exec(pathname);
  if (!statsMatch) {
    return false;
  }

  if (req.method !== 'GET') {
    sendJson(res, 404, { error: 'Not Found' });
    return true;
  }

  const encodedKey = statsMatch[1]!;
  let heroKey: string;
  try {
    heroKey = decodeURIComponent(encodedKey);
  } catch {
    sendJson(res, 400, { error: 'Invalid hero key encoding.' });
    return true;
  }

  const auth = await requireLeagueApiAuth(req, res, deps.resolveToken, { requireWos: true });
  if (!auth.ok) {
    return true;
  }
  const { league } = auth;

  const parsed = parseApiHeroStatsQuery(searchParams);
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return true;
  }

  try {
    const body = await loadApiHeroCombatStats({
      leagueId: league.leagueId,
      gameId: league.gameId,
      heroKey,
      query: parsed.value,
    });
    if (body === null) {
      sendJson(res, 404, { error: 'Not Found' });
      return true;
    }
    sendJson(res, 200, body);
  } catch (error) {
    log.error({ err: error, heroKey }, 'Unexpected error loading hero combat stats');
    sendJson(res, 500, { error: 'Internal Server Error' });
  }

  return true;
}
