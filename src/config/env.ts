import 'dotenv/config';

interface EnvConfig {
  discordToken: string;
  clientId: string;
  guildId: string;
  isDev: boolean;
  autoDeployCommands: boolean;
  databaseUrl: string;
  geminiApiKey: string;
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
};
