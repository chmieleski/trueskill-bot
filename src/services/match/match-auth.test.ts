import { describe, expect, it } from 'vitest';
import {
  BOT_OWNER_DISCORD_ID,
  UNIVERSAL_MATCH_MOD_DISCORD_IDS,
} from '../guild/guild-config.js';
import {
  assertCanCreateMatch,
  assertCanManageMatch,
  assertHasMatchModRole,
  canCreateMatch,
  canManageMatch,
  hasMatchModRole,
} from './match-auth.js';
import { MatchServiceError } from './match-service.js';

const EXTRA_UNIVERSAL_MOD_ID = '143479019097161728';

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

  it('allows the bot owner without a mod role', () => {
    expect(
      canManageMatch({
        hostDiscordId: 'host',
        actorDiscordId: BOT_OWNER_DISCORD_ID,
        memberRoleIds: [],
      }),
    ).toBe(true);
  });

  it('allows every universal match mod without a mod role', () => {
    expect(UNIVERSAL_MATCH_MOD_DISCORD_IDS.has(EXTRA_UNIVERSAL_MOD_ID)).toBe(true);
    for (const modId of UNIVERSAL_MATCH_MOD_DISCORD_IDS) {
      expect(
        canManageMatch({
          hostDiscordId: 'host',
          actorDiscordId: modId,
          memberRoleIds: [],
        }),
      ).toBe(true);
    }
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
    expect(
      hasMatchModRole({ actorDiscordId: 'user', memberRoleIds: ['role-mod'] }),
    ).toBe(false);
  });

  it('returns false when member lacks the role', () => {
    expect(
      hasMatchModRole({
        actorDiscordId: 'user',
        memberRoleIds: ['other'],
        matchModRoleId: 'role-mod',
      }),
    ).toBe(false);
  });

  it('returns true when member has the role', () => {
    expect(
      hasMatchModRole({
        actorDiscordId: 'user',
        memberRoleIds: ['role-mod', 'other'],
        matchModRoleId: 'role-mod',
      }),
    ).toBe(true);
  });

  it('returns true for the bot owner without a mod role', () => {
    expect(
      hasMatchModRole({
        actorDiscordId: BOT_OWNER_DISCORD_ID,
        memberRoleIds: [],
      }),
    ).toBe(true);
  });

  it('returns true for every universal match mod without a mod role', () => {
    for (const modId of UNIVERSAL_MATCH_MOD_DISCORD_IDS) {
      expect(
        hasMatchModRole({
          actorDiscordId: modId,
          memberRoleIds: [],
        }),
      ).toBe(true);
    }
  });
});

describe('assertHasMatchModRole', () => {
  it('throws not-configured when role unset', () => {
    expect(() =>
      assertHasMatchModRole({ actorDiscordId: 'user', memberRoleIds: [] }),
    ).toThrow('Match moderator role is not configured.');
  });

  it('throws forbidden when member lacks role', () => {
    expect(() =>
      assertHasMatchModRole({
        actorDiscordId: 'user',
        memberRoleIds: [],
        matchModRoleId: 'role-mod',
      }),
    ).toThrow('Only match moderators can do that.');
  });

  it('does not throw for the bot owner when role is unset', () => {
    expect(() =>
      assertHasMatchModRole({
        actorDiscordId: BOT_OWNER_DISCORD_ID,
        memberRoleIds: [],
      }),
    ).not.toThrow();
  });

  it('does not throw for a universal match mod when role is unset', () => {
    expect(() =>
      assertHasMatchModRole({
        actorDiscordId: EXTRA_UNIVERSAL_MOD_ID,
        memberRoleIds: [],
      }),
    ).not.toThrow();
  });
});
