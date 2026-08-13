import 'dotenv/config';

const LOG_LEVELS = new Set([
  'fatal',
  'error',
  'warn',
  'info',
  'verbose',
  'debug',
  'trace',
]);

interface EnvConfig {
  discordToken: string;
  clientId: string;
  guildId: string;
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
}

function parseLogLevel(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (!LOG_LEVELS.has(normalized)) {
    throw new Error(
      `Invalid LOG_LEVEL "${value}". Expected one of: ${[...LOG_LEVELS].join(', ')}`,
    );
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
  guildId: requireEnv('GUILD_ID'),
  isDev: process.env.NODE_ENV !== 'production',
  autoDeployCommands: parseBoolean(process.env.AUTO_DEPLOY_COMMANDS, process.env.NODE_ENV !== 'production'),
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
};
