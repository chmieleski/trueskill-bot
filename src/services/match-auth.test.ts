import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    matchCreateRoleId: undefined as string | undefined,
    matchModRoleId: undefined as string | undefined,
    // unused by match-auth but keep object shape flexible
  },
}));

import { env } from '../config/env.js';
import { assertCanCreateMatch, canCreateMatch } from './match-auth.js';
import { MatchServiceError } from './match-service.js';

describe('canCreateMatch', () => {
  beforeEach(() => {
    env.matchCreateRoleId = undefined;
  });

  it('returns false when MATCH_CREATE_ROLE_ID is unset', () => {
    expect(canCreateMatch({ memberRoleIds: ['111'] })).toBe(false);
  });

  it('returns false when member lacks the create role', () => {
    env.matchCreateRoleId = 'role-create';
    expect(canCreateMatch({ memberRoleIds: ['other'] })).toBe(false);
  });

  it('returns true when member has the create role', () => {
    env.matchCreateRoleId = 'role-create';
    expect(canCreateMatch({ memberRoleIds: ['role-create', 'other'] })).toBe(true);
  });
});

describe('assertCanCreateMatch', () => {
  beforeEach(() => {
    env.matchCreateRoleId = undefined;
  });

  it('throws disabled message when env is unset', () => {
    expect(() => assertCanCreateMatch({ memberRoleIds: [] })).toThrow(MatchServiceError);
    expect(() => assertCanCreateMatch({ memberRoleIds: [] })).toThrow(
      'Match creation is disabled until MATCH_CREATE_ROLE_ID is configured.',
    );
  });

  it('throws creator-role message when member lacks role', () => {
    env.matchCreateRoleId = 'role-create';
    expect(() => assertCanCreateMatch({ memberRoleIds: ['other'] })).toThrow(
      'Only members with the match creator role can register a lobby.',
    );
  });

  it('does not throw when member has the create role', () => {
    env.matchCreateRoleId = 'role-create';
    expect(() => assertCanCreateMatch({ memberRoleIds: ['role-create'] })).not.toThrow();
  });
});
