import { describe, expect, it, vi } from 'vitest';
import { wipeChannelMessages } from './wipe-channel-messages.js';

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

function msg(id: string, ageMs: number) {
  return {
    id,
    createdTimestamp: Date.now() - ageMs,
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe('wipeChannelMessages', () => {
  it('bulk-deletes recent messages and stops when empty', async () => {
    const a = msg('1', 1000);
    const b = msg('2', 2000);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Map([
          ['1', a],
          ['2', b],
        ]),
      )
      .mockResolvedValueOnce(new Map());
    const bulkDelete = vi.fn().mockResolvedValue(undefined);
    const channel = { messages: { fetch }, bulkDelete };

    const deleted = await wipeChannelMessages(channel as never);
    expect(deleted).toBe(2);
    expect(bulkDelete).toHaveBeenCalled();
    expect(a.delete).not.toHaveBeenCalled();
  });

  it('individually deletes messages older than 14 days', async () => {
    const old = msg('old', TWO_WEEKS_MS + 60_000);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Map([['old', old]]))
      .mockResolvedValueOnce(new Map());
    const bulkDelete = vi.fn().mockResolvedValue(undefined);
    const channel = { messages: { fetch }, bulkDelete };

    const deleted = await wipeChannelMessages(channel as never);
    expect(deleted).toBe(1);
    expect(old.delete).toHaveBeenCalledOnce();
  });
});
