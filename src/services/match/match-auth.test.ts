import { describe, expect, it } from 'vitest';
import {
  assertCanCreateMatch,
  assertCanManageMatch,
  assertHasMatchModRole,
  canCreateMatch,
  canManageMatch,
  hasMatchModRole,
} from './match-auth.js';
import { MatchServiceError } from './match-service.js';

describe('canManageMatch', () => {
  it('allows the host without a mod role', () => {
    expect(
      canManageMatch({
        hostDiscordId: 'host',
        actorDiscordId: 'host',
        memberRoleIds: [],
      }),
    ).toBe(true);
  });

  it('rejects non-host when mod role is unset', () => {
    expect(
      canManageMatch({
        hostDiscordId: 'host',
        actorDiscordId: 'other',
        memberRoleIds: ['role-mod'],
      }),
    ).toBe(false);
  });

  it('allows non-host with matching mod role', () => {
    expect(
      canManageMatch({
        hostDiscordId: 'host',
        actorDiscordId: 'mod',
        memberRoleIds: ['role-mod'],
        matchModRoleId: 'role-mod',
      }),
    ).toBe(true);
  });
});

describe('canCreateMatch', () => {
  it('returns false when create role is unset', () => {
    expect(canCreateMatch({ memberRoleIds: ['111'] })).toBe(false);
  });

  it('returns false when member lacks the create role', () => {
    expect(
      canCreateMatch({ memberRoleIds: ['other'], matchCreateRoleId: 'role-create' }),
    ).toBe(false);
  });

  it('returns true when member has the create role', () => {
    expect(
      canCreateMatch({
        memberRoleIds: ['role-create', 'other'],
        matchCreateRoleId: 'role-create',
      }),
    ).toBe(true);
  });
});

describe('assertCanCreateMatch', () => {
  it('throws disabled message when create role is unset', () => {
    expect(() => assertCanCreateMatch({ memberRoleIds: [] })).toThrow(MatchServiceError);
    expect(() => assertCanCreateMatch({ memberRoleIds: [] })).toThrow(
      'Match creation is disabled until a create role is configured.',
    );
  });

  it('throws creator-role message when member lacks role', () => {
    expect(() =>
      assertCanCreateMatch({ memberRoleIds: ['other'], matchCreateRoleId: 'role-create' }),
    ).toThrow('Only members with the match creator role can register a lobby.');
  });

  it('does not throw when member has the create role', () => {
    expect(() =>
      assertCanCreateMatch({
        memberRoleIds: ['role-create'],
        matchCreateRoleId: 'role-create',
      }),
    ).not.toThrow();
  });
});

describe('assertCanManageMatch', () => {
  it('throws when actor cannot manage', () => {
    expect(() =>
      assertCanManageMatch({
        hostDiscordId: 'host',
        actorDiscordId: 'other',
        memberRoleIds: [],
      }),
    ).toThrow('Only the match host or a match moderator can do that.');
  });
});

describe('hasMatchModRole', () => {
  it('returns false when mod role is unset', () => {
    expect(hasMatchModRole({ memberRoleIds: ['role-mod'] })).toBe(false);
  });

  it('returns false when member lacks the role', () => {
    expect(
      hasMatchModRole({ memberRoleIds: ['other'], matchModRoleId: 'role-mod' }),
    ).toBe(false);
  });

  it('returns true when member has the role', () => {
    expect(
      hasMatchModRole({
        memberRoleIds: ['role-mod', 'other'],
        matchModRoleId: 'role-mod',
      }),
    ).toBe(true);
  });
});

describe('assertHasMatchModRole', () => {
  it('throws not-configured when role unset', () => {
    expect(() => assertHasMatchModRole({ memberRoleIds: [] })).toThrow(
      'Match moderator role is not configured.',
    );
  });

  it('throws forbidden when member lacks role', () => {
    expect(() =>
      assertHasMatchModRole({ memberRoleIds: [], matchModRoleId: 'role-mod' }),
    ).toThrow('Only match moderators can do that.');
  });
});
