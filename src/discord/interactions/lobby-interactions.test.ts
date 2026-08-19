import type { Interaction } from 'discord.js';
import { ButtonStyle, MessageFlags } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchServiceError } from '../../services/match/index.js';
import { clearEphemeralSessionsForTests } from '../../lib/ephemeral-session.js';

const {
  resolvePendingMatchByMessageId,
  cancelLobbyMatch,
  resolveGuildConfig,
  assertCanManageMatch,
} = vi.hoisted(() => ({
  resolvePendingMatchByMessageId: vi.fn(),
  cancelLobbyMatch: vi.fn(),
  resolveGuildConfig: vi.fn(),
  assertCanManageMatch: vi.fn(),
}));

vi.mock('../../services/lobby/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/lobby/index.js')>();
  return {
    ...actual,
    resolvePendingMatchByMessageId,
    cancelLobbyMatch,
  };
});

vi.mock('../../services/guild/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/guild/index.js')>();
  return {
    ...actual,
    resolveGuildConfig,
  };
});

vi.mock('../../services/match/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/match/index.js')>();
  return {
    ...actual,
    assertCanManageMatch,
  };
});

import { handleLobbyInteraction } from './lobby-interactions.js';

const FORBIDDEN = 'Only the match host or a match moderator can do that.';
const PENDING = {
  match: { id: 'match-1', hostDiscordId: 'host-1', status: 'PENDING' },
  players: [],
};

function buttonInteraction(customId: string, overrides: Record<string, unknown> = {}): Interaction {
  return {
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    customId,
    user: { id: 'host-1' },
    guildId: 'guild-1',
    channelId: 'channel-1',
    applicationId: 'app-1',
    token: 'token-1',
    member: { roles: [] },
    message: { id: 'msg-1' },
    client: {},
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue({ id: 'ephemeral-1' }),
    editReply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Interaction;
}

describe('handleLobbyInteraction pending cancel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearEphemeralSessionsForTests();
    resolvePendingMatchByMessageId.mockResolvedValue(PENDING);
    resolveGuildConfig.mockResolvedValue({ matchModRoleId: 'mod-role' });
    assertCanManageMatch.mockImplementation(() => undefined);
    cancelLobbyMatch.mockResolvedValue({ match: PENDING.match, players: [] });
  });

  it('shows confirm to the host and does not cancel yet', async () => {
    const interaction = buttonInteraction('lobby:cancel');

    await expect(handleLobbyInteraction(interaction)).resolves.toBe(true);

    expect(resolvePendingMatchByMessageId).toHaveBeenCalledWith({ messageId: 'msg-1' });
    expect(assertCanManageMatch).toHaveBeenCalledWith({
      hostDiscordId: 'host-1',
      actorDiscordId: 'host-1',
      memberRoleIds: [],
      matchModRoleId: 'mod-role',
    });
    expect(cancelLobbyMatch).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledOnce();
    const payload = vi.mocked(interaction.reply).mock.calls[0]![0] as {
      content: string;
      flags: number;
      components: Array<{
        toJSON: () => { components: Array<{ custom_id: string; label: string; style: number }> };
      }>;
    };
    expect(payload.content).toBe('Cancel lobby `match-1`?');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.components[0]?.toJSON().components).toEqual([
      expect.objectContaining({
        custom_id: 'lobby:cancel:ok:match-1',
        label: 'Cancel Lobby',
        style: ButtonStyle.Danger,
      }),
      expect.objectContaining({
        custom_id: 'lobby:cancel:no:match-1',
        label: 'Keep Lobby',
        style: ButtonStyle.Secondary,
      }),
    ]);
  });

  it('refuses an outsider and does not cancel', async () => {
    assertCanManageMatch.mockImplementation(() => {
      throw new MatchServiceError(FORBIDDEN);
    });
    const interaction = buttonInteraction('lobby:cancel', { user: { id: 'player-1' } });

    await expect(handleLobbyInteraction(interaction)).resolves.toBe(true);

    expect(cancelLobbyMatch).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: FORBIDDEN,
      flags: MessageFlags.Ephemeral,
      components: [],
    });
  });

  it('confirms with matchId from the custom id', async () => {
    const interaction = buttonInteraction('lobby:cancel:ok:match-1', {
      message: { id: 'ephemeral-not-lobby' },
    });

    await expect(handleLobbyInteraction(interaction)).resolves.toBe(true);

    expect(resolvePendingMatchByMessageId).not.toHaveBeenCalled();
    expect(cancelLobbyMatch).toHaveBeenCalledWith({
      client: interaction.client,
      actorDiscordId: 'host-1',
      matchId: 'match-1',
      memberRoleIds: [],
      matchModRoleId: 'mod-role',
    });
    expect(interaction.update).toHaveBeenCalledWith({
      content: 'Match `match-1` cancelled.',
      components: [],
    });
  });

  it('keeps the lobby without calling cancel', async () => {
    const interaction = buttonInteraction('lobby:cancel:no:match-1', {
      message: { id: 'ephemeral-not-lobby' },
    });

    await expect(handleLobbyInteraction(interaction)).resolves.toBe(true);

    expect(cancelLobbyMatch).not.toHaveBeenCalled();
    expect(resolvePendingMatchByMessageId).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith({
      content: 'Match `match-1` was not cancelled.',
      components: [],
    });
  });
});
