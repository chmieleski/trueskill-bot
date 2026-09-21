import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { env } from '../../config/env.js';
import { createLogger } from '../../lib/logger.js';
import { sendJson } from '../../api/http-io.js';
import { authorizeObsRequest } from './auth.js';
import { metricsRegistry } from './registry.js';

const log = createLogger('obs-http');

let runningServer: Server | undefined;

/**
 * Handle a single obs HTTP request (auth + /health + /status).
 * Returns true when the path was handled.
 */
export async function handleObsRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const auth = authorizeObsRequest({
    bind: env.obsBind,
    configuredToken: env.obsToken,
    authorizationHeader: req.headers.authorization,
  });
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.error });
    return true;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    const discordReady = metricsRegistry.isDiscordReady();
    const dbOk = metricsRegistry.isDbOk();
    if (discordReady && dbOk) {
      sendJson(res, 200, { ok: true });
    } else {
      const reason = !discordReady ? 'discord_not_ready' : 'db_unhealthy';
      sendJson(res, 503, { ok: false, reason });
    }
    return true;
  }

  if (req.method === 'GET' && path === '/status') {
    sendJson(res, 200, metricsRegistry.toSnapshot() as unknown as Record<string, unknown>);
    return true;
  }

  return false;
}

/** Start the observability HTTP listener when OBS_ENABLED. */
export async function startObsHttpServer(): Promise<Server | undefined> {
  if (!env.obsEnabled) {
    return undefined;
  }
  if (runningServer) {
    return runningServer;
  }

  const server = createServer((req, res) => {
    void handleObsRequest(req, res)
      .then((handled) => {
        if (!handled && !res.headersSent) {
          sendJson(res, 404, { error: 'Not Found' });
        }
      })
      .catch((error) => {
        log.error({ err: error }, 'Unhandled obs HTTP error');
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'Internal Server Error' });
        }
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.obsPort, env.obsBind, () => {
      server.off('error', reject);
      resolve();
    });
  });

  runningServer = server;
  log.info({ bind: env.obsBind, port: env.obsPort }, 'Observability HTTP listening');
  return server;
}

/** Close the observability HTTP server. */
export async function stopObsHttpServer(): Promise<void> {
  const server = runningServer;
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

  runningServer = undefined;
  log.info('Observability HTTP stopped');
}
