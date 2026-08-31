import { MessageType } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { leagueFindFirst, bindingFindUnique, guildConfigFindUnique } = vi.hoisted(() => ({
  leagueFindFirst: vi.fn(),
  bindingFindUnique: vi.fn(),
  guildConfigFindUnique: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: {
      findFirst: leagueFindFirst,
    },
    leagueChannelBinding: {
      findUnique: bindingFindUnique,
    },
    guildConfig: {
      findUnique: guildConfigFindUnique,
    },
  },
}));

import {
  isGuildLeagueCommandChannel,
  isGuildModeratedBotChannel,
  isMessageAuthorMatchModerator,
  purgeNonCommandMessage,
  shouldDeleteNonCommandMessage,
} from './league-channel-moderation.js';

describe('shouldDeleteNonCommandMessage', () => {
  it('keeps this bot messages', () => {
    expect(
      shouldDeleteNonCommandMessage({
        authorId: 'bot-1',
        botUserId: 'bot-1',
        messageType: MessageType.Default,
      }),
    ).toBe(false);
  });

  it('keeps slash and context menu command invocations', () => {
    expect(
      shouldDeleteNonCommandMessage({
        authorId: 'user-1',
        botUserId: 'bot-1',
        messageType: MessageType.ChatInputCommand,
      }),
    ).toBe(false);
    expect(
      shouldDeleteNonCommandMessage({
        authorId: 'user-1',
        botUserId: 'bot-1',
        messageType: MessageType.ContextMenuCommand,
      }),
    ).toBe(false);
  });

  it('deletes regular user chat and other bot posts', () => {
    expect(
      shouldDeleteNonCommandMessage({
        authorId: 'user-1',
        botUserId: 'bot-1',
        messageType: MessageType.Default,
      }),
    ).toBe(true);
    expect(
      shouldDeleteNonCommandMessage({
        authorId: 'other-bot',
        botUserId: 'bot-1',
        messageType: MessageType.Default,
      }),
    ).toBe(true);
  });
});

describe('isGuildLeagueCommandChannel', () => {
  beforeEach(() => {
    bindingFindUnique.mockReset();
  });

  it('returns true for a direct channel binding in the guild', async () => {
    bindingFindUnique.mockResolvedValueOnce({
      kind: 'CHANNEL',
      league: { guildId: 'g1' },
    });

    await expect(isGuildLeagueCommandChannel('g1', 'cmd', null)).resolves.toBe(true);
    expect(bindingFindUnique).toHaveBeenCalledWith({
      where: { discordId: 'cmd' },
      include: { league: { select: { guildId: true } } },
    });
  });

  it('returns true for a channel under a bound category', async () => {
    bindingFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      kind: 'CATEGORY',
      league: { guildId: 'g1' },
    });

    await expect(isGuildLeagueCommandChannel('g1', 'child', 'cat-1')).resolves.toBe(true);
  });

  it('returns false when binding belongs to another guild', async () => {
    bindingFindUnique.mockResolvedValueOnce({
      kind: 'CHANNEL',
      league: { guildId: 'other' },
    });

    await expect(isGuildLeagueCommandChannel('g1', 'cmd', null)).resolves.toBe(false);
  });
});

describe('isGuildModeratedBotChannel', () => {
  beforeEach(() => {
    leagueFindFirst.mockReset();
    bindingFindUnique.mockReset();
  });

  it('returns true for a ready lobby channel without checking bindings', async () => {
    leagueFindFirst.mockResolvedValueOnce({ id: 'L1' });

    await expect(isGuildModeratedBotChannel('g1', 'lobby', null)).resolves.toBe(true);
    expect(bindingFindUnique).not.toHaveBeenCalled();
  });

  it('falls back to league command channel bindings', async () => {
    leagueFindFirst.mockResolvedValueOnce(null);
    bindingFindUnique.mockResolvedValueOnce({
      kind: 'CHANNEL',
      league: { guildId: 'g1' },
    });

    await expect(isGuildModeratedBotChannel('g1', 'cmds', null)).resolves.toBe(true);
  });
});

describe('isMessageAuthorMatchModerator', () => {
  beforeEach(() => {
    guildConfigFindUnique.mockReset();
  });

  it('returns true for universal match mods without fetching guild config roles', async () => {
    guildConfigFindUnique.mockResolvedValueOnce(null);

    await expect(
      isMessageAuthorMatchModerator({
        guildId: 'g1',
        author: { id: '723326675647070218' },
        member: null,
        guild: null,
      } as never),
    ).resolves.toBe(true);
  });

  it('returns true when the author has the configured match mod role', async () => {
    guildConfigFindUnique.mockResolvedValueOnce({ matchModRoleId: 'role-mod' });
    const fetchedMember = { roles: { cache: new Map([['role-mod', {}]]) } };

    await expect(
      isMessageAuthorMatchModerator({
        guildId: 'g1',
        author: { id: 'user-1' },
        member: null,
        guild: { members: { fetch: vi.fn().mockResolvedValue(fetchedMember) } },
      } as never),
    ).resolves.toBe(true);
  });

  it('returns false for regular members', async () => {
    guildConfigFindUnique.mockResolvedValueOnce({ matchModRoleId: 'role-mod' });
    const fetchedMember = { roles: { cache: new Map([['role-player', {}]]) } };

    await expect(
      isMessageAuthorMatchModerator({
        guildId: 'g1',
        author: { id: 'user-1' },
        member: null,
        guild: { members: { fetch: vi.fn().mockResolvedValue(fetchedMember) } },
      } as never),
    ).resolves.toBe(false);
  });
});

describe('purgeNonCommandMessage', () => {
  beforeEach(() => {
    leagueFindFirst.mockReset();
    bindingFindUnique.mockReset();
    guildConfigFindUnique.mockReset();
  });

  it('skips deletion for match moderator chat in a moderated channel', async () => {
    leagueFindFirst.mockResolvedValueOnce({ id: 'L1' });
    guildConfigFindUnique.mockResolvedValueOnce({ matchModRoleId: 'role-mod' });
    const fetchedMember = { roles: { cache: new Map([['role-mod', {}]]) } };

    const del = vi.fn();
    const message = {
      guildId: 'g1',
      channelId: 'lobby',
      id: 'msg-1',
      type: MessageType.Default,
      author: { id: 'mod-user' },
      client: { user: { id: 'bot-1' } },
      channel: { parentId: null },
      member: null,
      guild: { members: { fetch: vi.fn().mockResolvedValue(fetchedMember) } },
      delete: del,
    } as never;

    await purgeNonCommandMessage(message);

    expect(del).not.toHaveBeenCalled();
  });
});
