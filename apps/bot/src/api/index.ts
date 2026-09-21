import type { Server } from 'node:http';
import {
  handleApiRequest,
  startApiServer,
  stopApiServer,
  type ApiServerDeps,
} from './http-server.js';

export { handleApiRequest, startApiServer, stopApiServer, type ApiServerDeps };

/** Process-wide handle so ClientReady can start and shutdown can stop. */
let runningApiServer: Server | undefined;

/** Start the API and remember the server for later shutdown. */
export async function startBotApiServer(deps: ApiServerDeps): Promise<Server> {
  runningApiServer = await startApiServer(deps);
  return runningApiServer;
}

/** Stop the API server started by {@link startBotApiServer}. */
export async function stopBotApiServer(): Promise<void> {
  await stopApiServer(runningApiServer);
  runningApiServer = undefined;
}
