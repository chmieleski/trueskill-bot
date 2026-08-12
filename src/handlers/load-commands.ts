import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Client } from 'discord.js';
import type { Command } from '../types/command.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function collectCommandFiles(directory: string): string[] {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectCommandFiles(fullPath));
      continue;
    }

    if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
      files.push(fullPath);
    }
  }

  return files;
}

export async function loadCommands(client: Client): Promise<void> {
  const commandsPath = path.join(__dirname, '..', 'commands');

  if (!fs.existsSync(commandsPath)) {
    return;
  }

  const commandFiles = collectCommandFiles(commandsPath);

  for (const filePath of commandFiles) {
    const commandModule = (await import(pathToFileURL(filePath).href)) as {
      default?: Command;
      data?: Command['data'];
      execute?: Command['execute'];
    };

    const command: Command | undefined =
      commandModule.default ??
      (commandModule.data && commandModule.execute
        ? { data: commandModule.data, execute: commandModule.execute }
        : undefined);

    if (!command?.data || !command.execute) {
      console.warn(`[commands] Skipped file (missing data/execute): ${filePath}`);
      continue;
    }

    client.commands.set(command.data.name, command);
    console.log(`[commands] Loaded: /${command.data.name}`);
  }
}

export async function getCommandPayloads(): Promise<ReturnType<Command['data']['toJSON']>[]> {
  const commandsPath = path.join(__dirname, '..', 'commands');

  if (!fs.existsSync(commandsPath)) {
    return [];
  }

  const commandFiles = collectCommandFiles(commandsPath);
  const payloads: ReturnType<Command['data']['toJSON']>[] = [];

  for (const filePath of commandFiles) {
    const commandModule = (await import(pathToFileURL(filePath).href)) as {
      default?: Command;
      data?: Command['data'];
      execute?: Command['execute'];
    };

    const command: Command | undefined =
      commandModule.default ??
      (commandModule.data && commandModule.execute
        ? { data: commandModule.data, execute: commandModule.execute }
        : undefined);

    if (!command?.data || !command.execute) {
      continue;
    }

    payloads.push(command.data.toJSON());
  }

  return payloads;
}
