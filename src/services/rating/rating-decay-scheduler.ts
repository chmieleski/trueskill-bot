import { createLogger } from '../../lib/logger.js';
import { runDecayBatchForAllLeagues, utcDayIndex } from './rating-decay.js';

const log = createLogger('rating_decay');
const INTERVAL_MS = 60 * 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | undefined;
let lastBatchUtcDay: number | undefined;

export async function runRatingDecayTick(now = new Date()): Promise<void> {
  const day = utcDayIndex(now);
  if (lastBatchUtcDay === day) {
    return;
  }
  const result = await runDecayBatchForAllLeagues(now);
  lastBatchUtcDay = day;
  log.info(result, 'Rating decay batch completed');
}

export function startRatingDecayScheduler(): void {
  if (intervalHandle) {
    log.warn('Rating decay scheduler already running');
    return;
  }
  const tick = (): void => {
    void runRatingDecayTick().catch((error: unknown) => {
      log.error({ err: error }, 'Rating decay tick failed');
    });
  };
  setTimeout(tick, 10_000);
  intervalHandle = setInterval(tick, INTERVAL_MS);
  log.info({ intervalMs: INTERVAL_MS }, 'Rating decay scheduler started');
}

export function stopRatingDecayScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
    log.info('Rating decay scheduler stopped');
  }
}
