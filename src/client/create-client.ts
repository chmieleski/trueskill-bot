import { Client, Collection, GatewayIntentBits } from 'discord.js';
import type { Command } from '../types/command.js';

declare module 'discord.js' {
  interface Client {
    commands: Collection<string, Command>;
  }
}

export function createClient(): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.commands = new Collection<string, Command>();

  return client;
}
