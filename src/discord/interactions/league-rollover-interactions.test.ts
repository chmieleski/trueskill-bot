import type { Interaction } from 'discord.js';
import { ButtonStyle, MessageFlags } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  applyLeagueRollover,
  cancelLeagueRolloverDraft,
  getLeagueById,
  refreshLeagueLeaderboard,
} = vi.hoisted(() => ({
  applyLeagueRollover: vi.fn(),
  cancelLeagueRolloverDraft: vi.fn(),
  getLeagueById: vi.fn(),
  refreshLeagueLeaderboard: vi.fn(),
}));

vi.mock('../../services/leaderboard/index.js', () => ({
  refreshLeagueLeaderboard,
}));

vi.mock('../../services/league/index.js', () => {
  class LeagueRolloverError extends Error {}
  const buildCustomId = (
    action: 'c' | 'x',
    draftId: string,
    actorDiscordId: string,
  ) => `lv:${action}:${draftId}:${actorDiscordId}`;

  return {
    applyLeagueRollover,
    buildRolloverCancelCustomId: (draftId: string, actorDiscordId: string) =>
      buildCustomId('x', draftId, actorDiscordId),
    buildRolloverConfirmCustomId: (draftId: string, actorDiscordId: string) =>
      buildCustomId('c', draftId, actorDiscordId),
    cancelLeagueRolloverDraft,
    getLeagueById,
    LeagueRolloverError,
    parseRolloverButtonCustomId: (customId: string) => {
      const [prefix, action, draftId, actorDiscordId, extra] =
        customId.split(':');
      if (
        prefix !== 'lv' ||
        (action !== 'c' && action !== 'x') ||
        !draftId ||
        !actorDiscordId ||
        extra !== undefined
      ) {
        return null;
      }
      return {
        action: action === 'c' ? 'confirm' : 'cancel',
        draftId,
        actorDiscordId,
      };
    },
  };
});

import {
  buildRolloverConfirmComponents,
  handleLeagueRolloverInteraction,
} from './league-rollover-interactions.js';
import { LeagueRolloverError } from '../../services/league/index.js';

function buttonInteraction(
  customId: string,
  overrides: Record<string, unknown> = {},
): Interaction {
  return {
    isButton: () => true,
    customId,
    user: { id: 'actor-1' },
    guildId: 'guild-1',
    client: { user: { id: 'bot-1' } },
    reply: vi.fn(),
    update: vi.fn(),
    deferUpdate: vi.fn(),
    editReply: vi.fn(),
    ...overrides,
  } as unknown as Interaction;
}

const rolloverResult = {
  archivedLeagueId: 'league-old',
  archivedLeagueName: 'Season 1',
  successorLeagueId: 'league-new',
  successorLeagueName: 'Season 2',
  resetMode: 'soft' as const,
  compression: 0.5,
  playersSeeded: 12,
  bindingsMoved: 2,
};

describe('buildRolloverConfirmComponents', () => {
  it('builds confirm and cancel buttons', () => {
    const [row] = buildRolloverConfirmComponents({
      draftId: 'draft-1',
      actorDiscordId: 'actor-1',
    });

    expect(row?.toJSON()).toEqual({
      type: 1,
      components: [
        {
          type: 2,
          custom_id: 'lv:c:draft-1:actor-1',
          label: 'Confirm',
          style: ButtonStyle.Danger,
        },
        {
          type: 2,
          custom_id: 'lv:x:draft-1:actor-1',
          label: 'Cancel',
          style: ButtonStyle.Secondary,
        },
      ],
    });
  });
});

describe('handleLeagueRolloverInteraction', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    applyLeagueRollover.mockResolvedValue(rolloverResult);
    cancelLeagueRolloverDraft.mockResolvedValue(undefined);
    getLeagueById.mockResolvedValue({
      id: 'league-new',
      leaderboardChannelId: 'channel-1',
    });
  });

  it('ignores unrelated interactions', async () => {
    const interaction = buttonInteraction('leaderboard:overall:1');

    await expect(handleLeagueRolloverInteraction(interaction)).resolves.toBe(false);
  });

  it('consumes malformed rollover button IDs', async () => {
    const interaction = buttonInteraction('lv:invalid');

    await expect(handleLeagueRolloverInteraction(interaction)).resolves.toBe(true);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('rejects a click from someone other than the initiating actor', async () => {
    const interaction = buttonInteraction('lv:c:draft-1:actor-2');

    await expect(handleLeagueRolloverInteraction(interaction)).resolves.toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Only the person who ran /league rollover can use these buttons.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('cancels and removes the confirmation buttons', async () => {
    const interaction = buttonInteraction('lv:x:draft-1:actor-1');

    await expect(handleLeagueRolloverInteraction(interaction)).resolves.toBe(true);
    expect(cancelLeagueRolloverDraft).toHaveBeenCalledWith('draft-1', 'actor-1');
    expect(interaction.update).toHaveBeenCalledWith({
      content: 'Rollover cancelled.',
      components: [],
    });
  });

  it('applies the rollover and refreshes the successor leaderboard when configured', async () => {
    const interaction = buttonInteraction('lv:c:draft-1:actor-1');

    await expect(handleLeagueRolloverInteraction(interaction)).resolves.toBe(true);

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(applyLeagueRollover).toHaveBeenCalledWith({
      draftId: 'draft-1',
      actorDiscordId: 'actor-1',
    });
    expect(getLeagueById).toHaveBeenCalledWith('league-new');
    expect(refreshLeagueLeaderboard).toHaveBeenCalledWith(
      interaction.client,
      'league-new',
    );
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: [
        'Rollover complete.',
        '• Archived: **Season 1** (`league-old`)',
        '• Successor: **Season 2** (`league-new`)',
        '• Reset: soft (compression 0.5)',
        '• Players seeded: 12',
        '• Bindings moved: 2',
      ].join('\n'),
      components: [],
    });
  });

  it('skips leaderboard refresh when the successor has no channel configured', async () => {
    getLeagueById.mockResolvedValue({
      id: 'league-new',
      leaderboardChannelId: null,
    });
    const interaction = buttonInteraction('lv:c:draft-1:actor-1');

    await expect(handleLeagueRolloverInteraction(interaction)).resolves.toBe(true);
    expect(refreshLeagueLeaderboard).not.toHaveBeenCalled();
  });

  it('shows hard-reset success copy without compression', async () => {
    applyLeagueRollover.mockResolvedValue({
      ...rolloverResult,
      resetMode: 'hard',
      compression: null,
    });
    const interaction = buttonInteraction('lv:c:draft-1:actor-1');

    await expect(handleLeagueRolloverInteraction(interaction)).resolves.toBe(true);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining('• Reset: hard'),
      components: [],
    });
  });

  it('shows LeagueRolloverError in the deferred reply', async () => {
    applyLeagueRollover.mockRejectedValue(
      new LeagueRolloverError('That rollover confirmation is no longer valid.'),
    );
    const interaction = buttonInteraction('lv:c:draft-1:actor-1');

    await expect(handleLeagueRolloverInteraction(interaction)).resolves.toBe(true);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'That rollover confirmation is no longer valid.',
      components: [],
    });
    expect(refreshLeagueLeaderboard).not.toHaveBeenCalled();
  });

  it('shows duplicate name message when confirm hits a P2002 constraint', async () => {
    applyLeagueRollover.mockRejectedValue({ code: 'P2002' });
    const interaction = buttonInteraction('lv:c:draft-1:actor-1');

    await expect(handleLeagueRolloverInteraction(interaction)).resolves.toBe(true);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        'A league with that name already exists for this game on this server.',
      components: [],
    });
    expect(refreshLeagueLeaderboard).not.toHaveBeenCalled();
  });
});
