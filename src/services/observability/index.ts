import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Client } from 'discord.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../lib/logger.js';
import { sendOpsAlert, setOpsAlerterClient } from './alerter.js';
import { startObsHttpServer, stopObsHttpServer } from './http-server.js';
import { metricsRegistry } from './registry.js';
import { startHealthSampler, stopHealthSampler } from './sampler.js';

export { authorizeObsRequest } from './auth.js';
export { resolveOpsAlertChannelIds } from './channel-resolver.js';
export { sendOpsAlert, setOpsAlerterClient, listOpsAlertChannelIds } from './alerter.js';
export { metricsRegistry } from './registry.js';
export { startHealthSampler, stopHealthSampler, runSample } from './sampler.js';
export { startObsHttpServer, stopObsHttpServer, handleObsRequest } from './http-server.js';
export { AlertCooldown } from './cooldown.js';
export { bytesToMb, isEventLoopAboveWarn, isRssAboveWarn, nsToMs } from './thresholds.js';

const log = createLogger('obs');

function readPackageVersion(): string {
  try {
    const pkgPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../package.json',
    );
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Start sampler + obs HTTP and bind Discord lifecycle hooks.
 * No-op when OBS_ENABLED is false.
 */
export async function startObservability(client: Client): Promise<void> {
  if (!env.obsEnabled) {
    log.info('Observability disabled (OBS_ENABLED=false)');
    return;
  }

  metricsRegistry.setVersion(readPackageVersion());
  metricsRegistry.setWosApiEnabled(env.apiEnabled);
  setOpsAlerterClient(client);

  const syncDiscord = (): void => {
    metricsRegistry.setDiscord({
      ready: client.isReady(),
      pingMs: client.ws.ping >= 0 ? Math.round(client.ws.ping) : null,
      guildCount: client.guilds.cache.size,
    });
  };

  syncDiscord();
  client.on('shardDisconnect', () => {
    syncDiscord();
    void sendOpsAlert('disconnect', 'WebSocket shard disconnected');
  });
  client.on('shardResume', () => {
    syncDiscord();
  });
  client.on('shardReady', () => {
    syncDiscord();
  });

  startHealthSampler();
  await startObsHttpServer();

  syncDiscord();
  await sendOpsAlert(
    'ready',
    `Logged in as \`${client.user?.tag ?? 'unknown'}\` · guilds \`${client.guilds.cache.size}\``,
  );
  log.info('Observability started');
}

/** Stop sampler and obs HTTP; best-effort shutdown alert. */
export async function stopObservability(signal?: string): Promise<void> {
  if (!env.obsEnabled) {
    return;
  }

  try {
    await sendOpsAlert('shutdown', signal ? `Signal \`${signal}\`` : undefined);
  } catch {
    // best-effort
  }

  stopHealthSampler();
  await stopObsHttpServer();
}
