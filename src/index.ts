import type { Client } from 'discord.js';
import { env } from './config/env.js';
import { createClient } from './client/create-client.js';
import { loadCommands } from './handlers/load-commands.js';
import { loadEvents } from './handlers/load-events.js';
import { registerCommands } from './handlers/register-commands.js';

let client: Client | undefined;

async function bootstrap(): Promise<void> {
  client = createClient();

  await loadCommands(client);

  if (env.autoDeployCommands) {
    await registerCommands();
  }

  await loadEvents(client);

  await client.login(env.discordToken);

  if (env.isDev) {
    console.log('[dev] Development mode — changes in src/ restart the bot automatically');
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`[shutdown] Shutting down bot (${signal})...`);

  if (client) {
    client.destroy();
  }

  process.exit(0);
}

process.on('SIGINT', (signal) => {
  void shutdown(signal);
});

process.on('SIGTERM', (signal) => {
  void shutdown(signal);
});

bootstrap().catch((error: unknown) => {
  console.error('[bootstrap] Failed to start bot:', error);
  process.exit(1);
});
