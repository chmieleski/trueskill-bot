import type { IncomingMessage, ServerResponse } from 'node:http';
import { getGameProfile } from '../domain/game-profile.js';
import type { LeagueApiTokenResolved } from '../services/league/league-api-token.js';
import { extractBearerToken } from './auth.js';
import { sendJson } from './http-io.js';

export type RequireLeagueResult = { ok: true; league: LeagueApiTokenResolved } | { ok: false };

/**
 * Extract Bearer, resolve token, optionally require WOS.
 * Sends 401/403 via sendJson on failure.
 */
export async function requireLeagueApiAuth(
  req: IncomingMessage,
  res: ServerResponse,
  resolveToken: (plaintext: string) => Promise<LeagueApiTokenResolved | null>,
  options: { requireWos: boolean },
): Promise<RequireLeagueResult> {
  const token = extractBearerToken(req.headers.authorization);
  if (token === null) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return { ok: false };
  }

  const league = await resolveToken(token);
  if (league === null) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return { ok: false };
  }

  if (options.requireWos && getGameProfile(league.gameId).postMatchStats !== 'wos2_bot_v1') {
    sendJson(res, 403, { error: 'Forbidden' });
    return { ok: false };
  }

  return { ok: true, league };
}
