import { describe, expect, it } from 'vitest';
import { getCommandPayloads } from './load-commands.js';

/** Discord rejects any single application command payload over 8000 bytes. */
const DISCORD_COMMAND_BYTE_LIMIT = 8000;

type CommandOption = {
  name: string;
  required?: boolean;
  type?: number;
  options?: CommandOption[];
};

function collectInvalidOptionOrder(options: CommandOption[] | undefined, path: string): string[] {
  const invalid: string[] = [];
  let sawOptional = false;

  for (const opt of options ?? []) {
    const required = opt.required ?? false;
    if (sawOptional && required) {
      invalid.push(`${path}.${opt.name}: required option after optional`);
    }
    if (!required) {
      sawOptional = true;
    }
    if (opt.options?.length) {
      invalid.push(...collectInvalidOptionOrder(opt.options, `${path}.${opt.name}`));
    }
  }

  return invalid;
}

describe('registerCommands payloads', () => {
  it('each slash command is within Discord size limit', async () => {
    const payloads = await getCommandPayloads();
    const oversized = payloads
      .map((payload) => ({
        name: payload.name,
        bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
      }))
      .filter((row) => row.bytes > DISCORD_COMMAND_BYTE_LIMIT);

    expect(oversized, JSON.stringify(oversized, null, 2)).toEqual([]);
  });

  it('keeps required slash options before optional ones (Discord deploy rule)', async () => {
    const payloads = await getCommandPayloads();
    const invalid: string[] = [];

    for (const cmd of payloads) {
      invalid.push(
        ...collectInvalidOptionOrder(cmd.options as CommandOption[] | undefined, cmd.name),
      );
      for (const opt of (cmd.options ?? []) as CommandOption[]) {
        if (opt.type === 1) {
          invalid.push(...collectInvalidOptionOrder(opt.options, `${cmd.name}.${opt.name}`));
        }
        if (opt.type === 2) {
          for (const sub of opt.options ?? []) {
            invalid.push(
              ...collectInvalidOptionOrder(sub.options, `${cmd.name}.${opt.name}.${sub.name}`),
            );
          }
        }
      }
    }

    expect(invalid, invalid.join('\n')).toEqual([]);
  });
});
