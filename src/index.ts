import type { Client } from 'discord.js';
import { stopBotApiServer } from './api/index.js';
import { env } from './config/env.js';
import { createClient } from './client/create-client.js';
import { loadCommands } from './handlers/load-commands.js';
import { loadEvents } from './handlers/load-events.js';
import { registerCommands } from './handlers/register-commands.js';
import { createLogger } from './lib/logger.js';
import { stopMatchCleanupScheduler } from './services/match/index.js';
import { stopLeaderboardRefreshScheduler } from './services/leaderboard/index.js';
import { stopWc3statsHostPromptScheduler } from './services/wc3stats/index.js';
import { rehydrateHeroDraftTimers } from './services/hero-draft/index.js';

const log = createLogger('bootstrap');

let client: Client | undefined;

async function bootstrap(): Promise<void> {
  log.info(
    {
      autoDeployCommands: env.autoDeployCommands,
      isDev: env.isDev,
      logLevel: env.logLevel ?? (env.isDev ? 'debug' : 'info'),
    },
    'Starting bot',
  );

  client = createClient();

  await loadCommands(client);

  if (env.autoDeployCommands) {
    await registerCommands();
  }

  await loadEvents(client);

  log.debug('Logging in to Discord…');
  await client.login(env.discordToken);

  try {
    await rehydrateHeroDraftTimers(client);
  } catch (error) {
    log.warn({ err: error }, 'Failed to rehydrate hero draft timers');
  }

  if (env.isDev) {
    log.info('Development mode — changes in src/ restart the bot automatically');
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  log.info({ signal }, 'Shutting down bot');

  stopMatchCleanupScheduler();
  stopLeaderboardRefreshScheduler();
  stopWc3statsHostPromptScheduler();
  await stopBotApiServer();

  if (client) {
    client.destroy();
    log.debug('Discord client destroyed');
  }

  process.exit(0);
}

process.on('SIGINT', (signal) => {
  void shutdown(signal);
});

process.on('SIGTERM', (signal) => {
  void shutdown(signal);
});

process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  log.fatal({ err: error }, 'Uncaught exception');
  process.exit(1);
});

bootstrap().catch((error: unknown) => {
  log.fatal({ err: error }, 'Failed to start bot');
  process.exit(1);
});
