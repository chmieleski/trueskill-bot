import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Client } from 'discord.js';
import { createLogger } from '../lib/logger.js';
import type { Command } from '../types/command.js';

const log = createLogger('commands');

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
    log.warn({ commandsPath }, 'Commands directory missing — skipping load');
    return;
  }

  const commandFiles = collectCommandFiles(commandsPath);
  log.debug({ count: commandFiles.length, commandsPath }, 'Scanning command files');

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
      log.warn({ filePath }, 'Skipped command file (missing data/execute)');
      continue;
    }

    client.commands.set(command.data.name, command);
    log.info({ command: command.data.name }, 'Loaded slash command');
  }

  log.debug({ loaded: client.commands.size }, 'Command load complete');
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
