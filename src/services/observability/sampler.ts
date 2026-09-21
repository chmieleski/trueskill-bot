import { monitorEventLoopDelay } from 'node:perf_hooks';
import { env } from '../../config/env.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { sendOpsAlert } from './alerter.js';
import { metricsRegistry } from './registry.js';
import { bytesToMb, isEventLoopAboveWarn, isRssAboveWarn, nsToMs } from './thresholds.js';

const log = createLogger('obs-sampler');

let intervalHandle: NodeJS.Timeout | undefined;
let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
let lastDbOk = true;

/** Start periodic health sampling (RSS, event-loop, DB ping). */
export function startHealthSampler(): void {
  if (!env.obsEnabled || intervalHandle) {
    return;
  }

  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const tick = (): void => {
    void runSample().catch((error) => {
      log.warn({ err: error }, 'Health sample failed');
    });
  };

  tick();
  intervalHandle = setInterval(tick, env.obsSampleIntervalMs);
  intervalHandle.unref();
}

/** Stop the health sampler. */
export function stopHealthSampler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
  if (histogram) {
    histogram.disable();
    histogram = undefined;
  }
}

/** Run one sample cycle and emit threshold alerts. */
export async function runSample(): Promise<void> {
  const mem = process.memoryUsage();
  const rssMb = bytesToMb(mem.rss);
  const heapUsedMb = bytesToMb(mem.heapUsed);
  const eventLoopP99Ms = histogram ? nsToMs(histogram.percentile(99)) : 0;
  histogram?.reset();

  let dbOk = true;
  let latencyMs: number | null = null;
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    latencyMs = Date.now() - started;
  } catch (error) {
    dbOk = false;
    latencyMs = Date.now() - started;
    log.warn({ err: error }, 'DB health ping failed');
  }

  metricsRegistry.setSample({ rssMb, heapUsedMb, eventLoopP99Ms }, { ok: dbOk, latencyMs });

  if (isRssAboveWarn(rssMb, env.obsRssMbWarn)) {
    await sendOpsAlert('high_rss', `RSS \`${rssMb} MiB\` (warn ≥ ${env.obsRssMbWarn})`);
  }

  if (isEventLoopAboveWarn(eventLoopP99Ms, env.obsEventLoopMsWarn)) {
    await sendOpsAlert(
      'event_loop_lag',
      `Event-loop p99 \`${eventLoopP99Ms} ms\` (warn ≥ ${env.obsEventLoopMsWarn})`,
    );
  }

  if (!dbOk) {
    await sendOpsAlert(
      'db_unhealthy',
      `DB ping failed${latencyMs != null ? ` after ${latencyMs} ms` : ''}`,
    );
  } else if (!lastDbOk) {
    await sendOpsAlert(
      'db_recovered',
      `DB ping ok${latencyMs != null ? ` (${latencyMs} ms)` : ''}`,
    );
  }

  lastDbOk = dbOk;
}
