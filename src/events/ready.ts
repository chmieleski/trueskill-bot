import type { Client } from 'discord.js';
import { Events } from 'discord.js';

export const name = Events.ClientReady;
export const once = true;

export async function execute(client: Client<true>): Promise<void> {
  console.log(`[ready] Bot online as ${client.user.tag}`);
}
