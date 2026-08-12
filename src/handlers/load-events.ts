import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Client } from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface BotEvent {
  name: string;
  once?: boolean;
  execute: (...args: unknown[]) => void | Promise<void>;
}

export async function loadEvents(client: Client): Promise<void> {
  const eventsPath = path.join(__dirname, '..', 'events');
  const eventFiles = fs
    .readdirSync(eventsPath)
    .filter((file) => file.endsWith('.ts') || file.endsWith('.js'));

  for (const file of eventFiles) {
    const filePath = path.join(eventsPath, file);
    const eventModule = (await import(pathToFileURL(filePath).href)) as {
      default?: BotEvent;
      name?: string;
      once?: boolean;
      execute?: BotEvent['execute'];
    };

    const event: BotEvent | undefined =
      eventModule.default ??
      (eventModule.name && eventModule.execute
        ? { name: eventModule.name, once: eventModule.once, execute: eventModule.execute }
        : undefined);

    if (!event?.name || !event.execute) {
      console.warn(`[events] Skipped file (missing name/execute): ${filePath}`);
      continue;
    }

    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args));
    } else {
      client.on(event.name, (...args) => event.execute(...args));
    }

    console.log(`[events] Loaded: ${event.name}${event.once ? ' (once)' : ''}`);
  }
}
