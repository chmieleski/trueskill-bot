import { describe, expect, it } from 'vitest';
import { data } from './sync-docs.js';

describe('sync_docs command', () => {
  it('registers public and staff subcommands with required channel', () => {
    const json = data.toJSON();
    expect(json.name).toBe('sync_docs');
    const names = (json.options ?? []).map((o) => o.name);
    expect(names).toEqual(expect.arrayContaining(['public', 'staff']));
  });
});
