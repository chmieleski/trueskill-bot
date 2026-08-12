import { REST, Routes } from 'discord.js';
import { env } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { getCommandPayloads } from './load-commands.js';

const log = createLogger('deploy');

export async function registerCommands(): Promise<number> {
  const commands = await getCommandPayloads();
  const rest = new REST().setToken(env.discordToken);

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
