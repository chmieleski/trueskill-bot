import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { assertCanSyncDocs, canSyncDocs, SYNC_DOCS_FORBIDDEN } from './docs-auth.js';
import { DocsServiceError } from './docs-errors.js';

describe('canSyncDocs', () => {
  it('allows Manage Server', () => {
    const perms = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
    expect(
      canSyncDocs({
        userId: 'u1',
        memberPermissions: perms,
        memberRoleIds: [],
      }),
    ).toBe(true);
  });

  it('allows configured mod role', () => {
    expect(
      canSyncDocs({
        userId: 'u1',
        memberPermissions: 0n,
        memberRoleIds: ['mod'],
        matchModRoleId: 'mod',
      }),
    ).toBe(true);
  });

  it('rejects everyone else', () => {
    expect(
      canSyncDocs({
        userId: 'u1',
        memberPermissions: 0n,
        memberRoleIds: ['other'],
        matchModRoleId: 'mod',
      }),
    ).toBe(false);
  });
});

describe('assertCanSyncDocs', () => {
  it('throws DocsServiceError when forbidden', () => {
    expect(() =>
      assertCanSyncDocs({
        userId: 'u1',
        memberPermissions: null,
        memberRoleIds: [],
      }),
    ).toThrow(DocsServiceError);
    expect(() =>
      assertCanSyncDocs({
        userId: 'u1',
        memberPermissions: null,
        memberRoleIds: [],
      }),
    ).toThrow(SYNC_DOCS_FORBIDDEN);
  });
});
