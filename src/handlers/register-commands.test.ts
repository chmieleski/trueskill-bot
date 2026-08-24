import { describe, expect, it } from 'vitest';
import { getCommandPayloads } from './load-commands.js';

/** Discord rejects any single application command payload over 8000 bytes. */
const DISCORD_COMMAND_BYTE_LIMIT = 8000;

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
});
