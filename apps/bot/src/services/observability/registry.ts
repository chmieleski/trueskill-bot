/**
 * In-process observability metrics registry.
 * Holds gauges/counters for the agent HTTP snapshot and health sampler.
 */

export type DiscordReadyState = {
  ready: boolean;
  pingMs: number | null;
  guildCount: number;
};

export type DbSample = {
  ok: boolean;
  latencyMs: number | null;
};

export type ProcessSample = {
  rssMb: number;
  heapUsedMb: number;
  eventLoopP99Ms: number;
};

export type ObservabilitySnapshot = {
  version: string;
  uptimeSec: number;
  discord: DiscordReadyState;
  process: { pid: number } & ProcessSample;
  db: DbSample;
  api: { wosEnabled: boolean };
  counters: { interactionsTotal: number; unhandledRejections: number };
  sampledAt: string | null;
};

/** Mutable registry for process observability readings. */
export class MetricsRegistry {
  readonly startedAtMs = Date.now();
  private discord: DiscordReadyState = { ready: false, pingMs: null, guildCount: 0 };
  private processSample: ProcessSample = { rssMb: 0, heapUsedMb: 0, eventLoopP99Ms: 0 };
  private db: DbSample = { ok: true, latencyMs: null };
  private sampledAt: string | null = null;
  private interactionsTotal = 0;
  private unhandledRejections = 0;
  private wosApiEnabled = false;
  private version = '0.0.0';

  /** Set package version shown in /status. */
  setVersion(version: string): void {
    this.version = version;
  }

  /** Record whether the WOS HTTP API listener is enabled. */
  setWosApiEnabled(enabled: boolean): void {
    this.wosApiEnabled = enabled;
  }

  /** Update Discord readiness snapshot. */
  setDiscord(state: DiscordReadyState): void {
    this.discord = state;
  }

  /** Apply the latest health sampler process + DB readings. */
  setSample(
    processSample: ProcessSample,
    db: DbSample,
    sampledAt = new Date().toISOString(),
  ): void {
    this.processSample = processSample;
    this.db = db;
    this.sampledAt = sampledAt;
  }

  /** Increment Discord interaction counter. */
  recordInteraction(): void {
    this.interactionsTotal += 1;
  }

  /** Increment unhandled rejection counter. */
  recordUnhandledRejection(): void {
    this.unhandledRejections += 1;
  }

  /** Build the JSON body for GET /status. */
  toSnapshot(): ObservabilitySnapshot {
    return {
      version: this.version,
      uptimeSec: Math.floor((Date.now() - this.startedAtMs) / 1000),
      discord: { ...this.discord },
      process: { pid: process.pid, ...this.processSample },
      db: { ...this.db },
      api: { wosEnabled: this.wosApiEnabled },
      counters: {
        interactionsTotal: this.interactionsTotal,
        unhandledRejections: this.unhandledRejections,
      },
      sampledAt: this.sampledAt,
    };
  }

  /** Latest Discord ready flag for /health. */
  isDiscordReady(): boolean {
    return this.discord.ready;
  }

  /** Latest DB ok flag for /health (true until first failed sample). */
  isDbOk(): boolean {
    return this.db.ok;
  }

  /** Latest process sample (for threshold checks). */
  getProcessSample(): ProcessSample {
    return { ...this.processSample };
  }

  /** Latest DB sample (for recovery alerts). */
  getDbSample(): DbSample {
    return { ...this.db };
  }
}

export const metricsRegistry = new MetricsRegistry();
