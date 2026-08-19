import { REST, Routes } from 'discord.js';
import { env } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { getCommandPayloads } from './load-commands.js';

const log = createLogger('deploy');

/**
 * Register slash commands globally or to a single guild depending on env.guildId.
 */
export async function registerCommands(): Promise<number> {
  const commands = await getCommandPayloads();
  const rest = new REST().setToken(env.discordToken);

  if (env.guildId) {
    log.info(
      { count: commands.length, guildId: env.guildId, clientId: env.clientId },
      'Registering guild slash commands',
    );

    const data = (await rest.put(Routes.applicationGuildCommands(env.clientId, env.guildId), {
      body: commands,
    })) as unknown[];

    log.info({ count: data.length }, 'Successfully registered guild slash commands');

    return data.length;
  }

  log.info({ count: commands.length, clientId: env.clientId }, 'Registering global slash commands');

  const data = (await rest.put(Routes.applicationCommands(env.clientId), {
    body: commands,
  })) as unknown[];

  log.info({ count: data.length }, 'Successfully registered global slash commands');

  return data.length;
}

/**
 * Remove all guild-scoped slash commands (ops cutover after switching to global deploy).
 */
export async function clearGuildCommands(guildId: string): Promise<void> {
  const rest = new REST().setToken(env.discordToken);

  log.info({ guildId, clientId: env.clientId }, 'Clearing guild slash commands');

  await rest.put(Routes.applicationGuildCommands(env.clientId, guildId), { body: [] });

  log.info({ guildId }, 'Successfully cleared guild slash commands');
}
