import { MessageType } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { leagueFindFirst, bindingFindUnique } = vi.hoisted(() => ({
  leagueFindFirst: vi.fn(),
  bindingFindUnique: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: {
      findFirst: leagueFindFirst,
    },
    leagueChannelBinding: {
      findUnique: bindingFindUnique,
    },
  },
}));

import {
  isGuildLeagueCommandChannel,
  isGuildModeratedBotChannel,
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
