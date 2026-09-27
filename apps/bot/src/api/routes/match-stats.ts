import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../../lib/logger.js';
import { loadApiMatchCombatStats } from '../../services/player/api-hero-combat-stats.js';
import { sendJson } from '../http-io.js';
import type { ApiServerDeps } from '../http-server.js';
import { requireLeagueApiAuth } from '../league-auth.js';

const log = createLogger('api-match-stats');

const MATCH_STATS_PATH = /^\/v1\/matches\/([^/]+)\/stats$/;

/**
 * Handle `GET /v1/matches/:matchId/stats`.
 * Returns true when the path matched (including wrong method → 404 for this path).
 */
export async function handleMatchStatsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
): Promise<boolean> {
  const pathname = (req.url ?? '').split('?')[0] ?? '';
  const match = MATCH_STATS_PATH.exec(pathname);
  if (!match) {
    return false;
  }

  if (req.method !== 'GET') {
    sendJson(res, 404, { error: 'Not Found' });
    return true;
  }

  const matchId = match[1]!;

  const auth = await requireLeagueApiAuth(req, res, deps.resolveToken, { requireWos: true });
  if (!auth.ok) {
    return true;
  }
  const { league } = auth;

  try {
    const body = await loadApiMatchCombatStats({
      leagueId: league.leagueId,
      gameId: league.gameId,
      matchId,
    });
    if (body === null) {
      sendJson(res, 404, { error: 'Not Found' });
      return true;
    }
    sendJson(res, 200, body);
  } catch (error) {
    log.error({ err: error, matchId }, 'Unexpected error loading match combat stats');
    sendJson(res, 500, { error: 'Internal Server Error' });
  }

  return true;
}
