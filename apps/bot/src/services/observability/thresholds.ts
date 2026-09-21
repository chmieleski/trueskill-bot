/** Pure threshold helpers for health alerts. */

/** True when RSS MiB meets or exceeds the warn threshold. */
export function isRssAboveWarn(rssMb: number, warnMb: number): boolean {
  return rssMb >= warnMb;
}

/** True when event-loop p99 ms meets or exceeds the warn threshold. */
export function isEventLoopAboveWarn(p99Ms: number, warnMs: number): boolean {
  return p99Ms >= warnMs;
}

/**
 * Convert bytes to whole MiB (floor).
 */
export function bytesToMb(bytes: number): number {
  return Math.floor(bytes / (1024 * 1024));
}

/**
 * Convert nanoseconds (monitorEventLoopDelay) to whole milliseconds.
 */
export function nsToMs(ns: number): number {
  return Math.floor(ns / 1e6);
}
