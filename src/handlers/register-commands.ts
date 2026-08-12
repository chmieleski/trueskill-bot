import { REST, Routes } from 'discord.js';
import { env } from '../config/env.js';
import { getCommandPayloads } from './load-commands.js';

export async function registerCommands(): Promise<number> {
  const commands = await getCommandPayloads();
  const rest = new REST().setToken(env.discordToken);

  console.log(`[deploy] Registering ${commands.length} command(s) in guild ${env.guildId}...`);

  const data = (await rest.put(Routes.applicationGuildCommands(env.clientId, env.guildId), {
    body: commands,
  })) as unknown[];

  console.log(`[deploy] Successfully registered ${data.length} command(s).`);

  return data.length;
}
