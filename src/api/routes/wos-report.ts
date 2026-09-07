import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../../lib/logger.js';
import { MatchServiceError } from '../../services/match/match-service.js';
import { attachApprovalDiscordMessage } from '../../services/match/match-waiting-approval.js';
import { extractBearerToken } from '../auth.js';
import { readJsonBody, sendJson } from '../http-io.js';
import type { ApiServerDeps } from '../http-server.js'; // type-only — avoid runtime cycle with http-server

const log = createLogger('api-wos-report');

const WOS_REPORT_PATH = '/v1/matches/wos-report';

/**
 * Handle `POST /v1/matches/wos-report` — bearer auth, ingest, optional Discord post.
 * Returns true when the path matched (including non-POST → 404 for this path).
 */
export async function handleWosReportRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
): Promise<boolean> {
  const url = req.url?.split('?')[0] ?? '';
  if (url !== WOS_REPORT_PATH) {
    return false;
  }

  if (req.method !== 'POST') {
    sendJson(res, 404, { error: 'Not Found' });
    return true;
  }

  const token = extractBearerToken(req.headers.authorization);
  if (token === null) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }

  const league = await deps.resolveToken(token);
  if (league === null) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request body.';
    sendJson(res, 400, { error: message });
    return true;
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: 'Request body must be a JSON object.' });
    return true;
  }

  const reportText = (body as { reportText?: unknown }).reportText;
  if (typeof reportText !== 'string') {
    sendJson(res, 400, { error: 'reportText must be a string.' });
    return true;
  }

  try {
    const result = await deps.ingest({
      leagueId: league.leagueId,
      guildId: league.guildId,
      gameId: league.gameId,
      matchApprovalChannelId: league.matchApprovalChannelId ?? '',
      hostDiscordId: deps.hostDiscordId,
      reportText,
    });

    let discordMessageUrl: string | null = null;
    const posted = await deps.postApprovalMessage({
      guildId: league.guildId,
      channelId: league.matchApprovalChannelId ?? '',
      matchId: result.matchId,
    });

    if (posted !== null) {
      await attachApprovalDiscordMessage(result.matchId, posted.messageId);
      discordMessageUrl = posted.messageUrl;
    }

    sendJson(res, 201, {
      matchId: result.matchId,
      status: result.status,
      externalId: result.externalId,
      suggestedWinner: result.suggestedWinner,
      discordMessageUrl,
    });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      const status = error.message.includes('already uploaded') ? 409 : 400;
      sendJson(res, status, { error: error.message });
      return true;
    }

    log.error({ err: error }, 'Unexpected error handling wos-report');
    sendJson(res, 500, { error: 'Internal Server Error' });
  }

  return true;
}
