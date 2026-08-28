/**
 * Print every Discord server the bot is installed in (Gateway guild list).
 *
 * Run: npx tsx scripts/list-guilds.ts
 *
 * Uses DISCORD_TOKEN from .env (or the environment). For production servers,
 * use the same token the live bot uses — not necessarily your dev GUILD_ID.
 */
import 'dotenv/config';
import { Client, Events, GatewayIntentBits } from 'discord.js';

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error('Missing DISCORD_TOKEN in .env or environment');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (readyClient) => {
  await readyClient.guilds.fetch();

  const guilds = [...readyClient.guilds.cache.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  console.log(`\nBot is in ${guilds.length} server(s):\n`);
  for (const guild of guilds) {
    console.log(`${guild.name}\t${guild.id}\t${guild.memberCount ?? '?'} members`);
  }

  await readyClient.destroy();
  process.exit(0);
});

client.login(token).catch((error: unknown) => {
  console.error('Failed to log in:', error);
  process.exit(1);
});
