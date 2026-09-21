import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

/**
 * Load monorepo root `.env` whether cwd is the repo root or `apps/bot`.
 */
function loadMonorepoEnv(): void {
  const fromThisFile = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
    fromThisFile,
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      loadEnv({ path });
      return;
    }
  }
  loadEnv();
}

loadMonorepoEnv();

const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'verbose', 'debug', 'trace']);

interface EnvConfig {
  discordToken: string;
  clientId: string;
  /** Discord guild ID for guild-scoped command deploy. Empty = global deploy. */
  guildId: string | undefined;
  isDev: boolean;
  autoDeployCommands: boolean;
  databaseUrl: string;
  geminiApiKey: string;
  /** Override default log level (dev: debug, prod: info). */
  logLevel: string | undefined;
  /** Discord role ID allowed to report/cancel matches like the host. Empty = host-only. */
  matchModRoleId: string | undefined;
  /** Discord role ID required to create lobbies via /register_lobby. Empty = creation disabled. */
  matchCreateRoleId: string | undefined;
  wc3statsTimeoutMs: number;
  /** Start HTTP listener in the bot process (WOS match ingest). */
  apiEnabled: boolean;
  /** HTTP API listen port. */
  apiPort: number;
  /** HTTP API bind address. */
  apiBind: string;
  /** Start process observability (sampler, Discord alerter, obs HTTP). */
  obsEnabled: boolean;
  /** Observability HTTP bind address. */
  obsBind: string;
  /** Observability HTTP listen port. */
  obsPort: number;
  /** Bearer token for obs HTTP when bind is not loopback. */
  obsToken: string | undefined;
  /** Process-wide Discord channel for ops alerts (fallback). */
  opsAlertChannelId: string | undefined;
  /** RSS MiB threshold for Discord high-memory alerts. */
  obsRssMbWarn: number;
  /** Event-loop delay p99 ms threshold for Discord lag alerts. */
  obsEventLoopMsWarn: number;
  /** Health sampler interval in milliseconds. */
  obsSampleIntervalMs: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** True when the bind address is loopback (token optional). */
export function isLoopbackBind(bind: string): boolean {
  const normalized = bind.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function parseLogLevel(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (!LOG_LEVELS.has(normalized)) {
    throw new Error(`Invalid LOG_LEVEL "${value}". Expected one of: ${[...LOG_LEVELS].join(', ')}`);
  }

  return normalized;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  return value === 'true' || value === '1';
}

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export const env: EnvConfig = {
  discordToken: requireEnv('DISCORD_TOKEN'),
  clientId: requireEnv('CLIENT_ID'),
  guildId: process.env.GUILD_ID?.trim() || undefined,
  isDev: process.env.NODE_ENV !== 'production',
  autoDeployCommands: parseBoolean(
    process.env.AUTO_DEPLOY_COMMANDS,
    process.env.NODE_ENV !== 'production',
  ),
  databaseUrl: requireEnv('DATABASE_URL'),
  geminiApiKey: requireEnv('GEMINI_API_KEY'),
  logLevel: parseLogLevel(process.env.LOG_LEVEL),
  matchModRoleId: (() => {
    const value = process.env.MATCH_MOD_ROLE_ID?.trim();
    return value && value.length > 0 ? value : undefined;
  })(),
  matchCreateRoleId: (() => {
    const value = process.env.MATCH_CREATE_ROLE_ID?.trim();
    return value && value.length > 0 ? value : undefined;
  })(),
  wc3statsTimeoutMs: Number.parseInt(process.env.WC3STATS_TIMEOUT_MS ?? '4000', 10) || 4000,
  apiEnabled: parseBoolean(process.env.API_ENABLED, false),
  apiPort: Number.parseInt(process.env.API_PORT ?? '8787', 10) || 8787,
  apiBind: process.env.API_BIND?.trim() || '0.0.0.0',
  obsEnabled: parseBoolean(process.env.OBS_ENABLED, true),
  obsBind: process.env.OBS_BIND?.trim() || '127.0.0.1',
  obsPort: parsePositiveInt(process.env.OBS_PORT, 8790),
  obsToken: optionalTrimmed(process.env.OBS_TOKEN),
  opsAlertChannelId: optionalTrimmed(process.env.OPS_ALERT_CHANNEL_ID),
  obsRssMbWarn: parsePositiveInt(process.env.OBS_RSS_MB_WARN, 512),
  obsEventLoopMsWarn: parsePositiveInt(process.env.OBS_EVENT_LOOP_MS_WARN, 200),
  obsSampleIntervalMs: parsePositiveInt(process.env.OBS_SAMPLE_INTERVAL_MS, 15_000),
};
