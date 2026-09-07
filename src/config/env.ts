import 'dotenv/config';

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
};
