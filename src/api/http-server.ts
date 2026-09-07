import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { env } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import type { ingestWosReportForApproval } from '../services/match/match-waiting-approval.js';
import type { resolveLeagueFromApiToken } from '../services/league/league-api-token.js';
import { sendJson } from './http-io.js';
import { handleWosReportRoute } from './routes/wos-report.js';

const log = createLogger('api');

export type ApiServerDeps = {
  ingest: typeof ingestWosReportForApproval;
  resolveToken: typeof resolveLeagueFromApiToken;
  postApprovalMessage: (input: {
    guildId: string;
    channelId: string;
    matchId: string;
  }) => Promise<{ messageId: string; messageUrl: string } | null>;
  hostDiscordId: string;
};

/** Dispatch a single HTTP request against the v1 API surface (no listen required). */
export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
): Promise<void> {
  try {
    const handled = await handleWosReportRoute(req, res, deps);
    if (!handled) {
      sendJson(res, 404, { error: 'Not Found' });
    }
  } catch (error) {
    log.error({ err: error }, 'Unhandled API request error');
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Internal Server Error' });
    }
  }
}

/** Start the HTTP API listener when `API_ENABLED` is true (caller still gates). */
export async function startApiServer(deps: ApiServerDeps): Promise<Server> {
  const server = createServer((req, res) => {
    void handleApiRequest(req, res, deps);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.apiPort, env.apiBind, () => {
      server.off('error', reject);
      resolve();
    });
  });

  log.info({ bind: env.apiBind, port: env.apiPort }, 'HTTP API listening');
  return server;
}

/** Close a previously started API server (no-op when undefined). */
export async function stopApiServer(server: Server | undefined): Promise<void> {
  if (!server) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  log.info('HTTP API stopped');
}
