import { describe, expect, it } from 'vitest';
import { compactUuidForCustomId, expandUuidFromCustomId } from './compact-custom-id.js';

describe('compactUuidForCustomId / expandUuidFromCustomId', () => {
  const hyphenated = 'e5863052-d453-48db-b67a-14d1175c298b';
  const compact = 'e5863052d45348dbb67a14d1175c298b';

  it('strips hyphens from a UUID and restores them', () => {
    expect(compactUuidForCustomId(hyphenated)).toBe(compact);
    expect(expandUuidFromCustomId(compact)).toBe(hyphenated);
  });

  it('leaves cuid and other non-UUID ids unchanged', () => {
    expect(compactUuidForCustomId('clleagueidxxxxxxxxxxxx')).toBe('clleagueidxxxxxxxxxxxx');
    expect(expandUuidFromCustomId('clleagueidxxxxxxxxxxxx')).toBe('clleagueidxxxxxxxxxxxx');
  });
});
