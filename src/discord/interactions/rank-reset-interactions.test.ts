import type { Interaction } from 'discord.js';
import { ButtonStyle, MessageFlags } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { applyRankReset, playerFindUnique, refreshLeagueLeaderboard, resolveGuildConfig } =
  vi.hoisted(() => ({
    applyRankReset: vi.fn(),
    playerFindUnique: vi.fn(),
    refreshLeagueLeaderboard: vi.fn(),
    resolveGuildConfig: vi.fn(),
  }));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    player: { findUnique: playerFindUnique },
  },
}));

vi.mock('../../services/guild/index.js', () => ({
  resolveGuildConfig,
}));

vi.mock('../../services/leaderboard/index.js', () => ({
  refreshLeagueLeaderboard,
}));

vi.mock('../../services/match/index.js', () => {
  class MatchServiceError extends Error {}
  return { MatchServiceError };
});

vi.mock('../../services/rating/index.js', () => {
  class RankResetServiceError extends Error {}
  const buildCustomId = (
    action: 'c' | 'x',
    leagueId: string,
    playerId: string,
    actorDiscordId: string,
  ) => `rr:${action}:${leagueId}:${playerId}:${actorDiscordId}`;

  return {
    applyRankReset,
    buildRankResetCancelCustomId: (leagueId: string, playerId: string, actorDiscordId: string) =>
      buildCustomId('x', leagueId, playerId, actorDiscordId),
    buildRankResetConfirmCustomId: (leagueId: string, playerId: string, actorDiscordId: string) =>
      buildCustomId('c', leagueId, playerId, actorDiscordId),
    parseRankResetButtonCustomId: (customId: string) => {
      const [prefix, action, leagueId, playerId, actorDiscordId, extra] = customId.split(':');
      if (
        prefix !== 'rr' ||
        (action !== 'c' && action !== 'x') ||
        !leagueId ||
        !playerId ||
        !actorDiscordId ||
        extra !== undefined
      ) {
        return null;
      }
      return {
        action: action === 'c' ? 'confirm' : 'cancel',
        leagueId,
        playerId,
        actorDiscordId,
      };
    },
    RankResetServiceError,
  };
});

import {
  buildRankResetConfirmComponents,
  handleRankResetInteraction,
} from './rank-reset-interactions.js';
import { MatchServiceError } from '../../services/match/index.js';
import { RankResetServiceError } from '../../services/rating/index.js';

function buttonInteraction(customId: string, overrides: Record<string, unknown> = {}): Interaction {
  return {
    isButton: () => true,
    customId,
    user: { id: 'actor-1' },
    guildId: 'guild-1',
    member: { roles: ['role-1'] },
    client: { user: { id: 'bot-1' } },
    reply: vi.fn(),
    update: vi.fn(),
    deferUpdate: vi.fn(),
    editReply: vi.fn(),
    ...overrides,
  } as unknown as Interaction;
}

describe('buildRankResetConfirmComponents', () => {
  it('builds compact confirm and cancel buttons', () => {
    const [row] = buildRankResetConfirmComponents({
      leagueId: 'league-1',
      playerId: 'player-1',
      actorDiscordId: 'actor-1',
    });

    expect(row?.toJSON()).toEqual({
      type: 1,
      components: [
        {
          type: 2,
          custom_id: 'rr:c:league-1:player-1:actor-1',
          label: 'Confirm reset',
          style: ButtonStyle.Danger,
        },
        {
          type: 2,
          custom_id: 'rr:x:league-1:player-1:actor-1',
          label: 'Cancel',
          style: ButtonStyle.Secondary,
        },
      ],
    });
  });
});

describe('handleRankResetInteraction', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    playerFindUnique.mockResolvedValue({
      id: 'player-1',
      username: 'Goku',
      discordId: 'target-1',
    });
    resolveGuildConfig.mockResolvedValue({ matchModRoleId: 'mod-role' });
    applyRankReset.mockResolvedValue({
      playerId: 'player-1',
      username: 'Goku',
      staffOverride: true,
    });
  });

  it('ignores unrelated interactions', async () => {
    const interaction = buttonInteraction('leaderboard:overall:1');

    await expect(handleRankResetInteraction(interaction)).resolves.toBe(false);
  });

  it('consumes malformed rank-reset button IDs', async () => {
    const interaction = buttonInteraction('rr:invalid');

    await expect(handleRankResetInteraction(interaction)).resolves.toBe(true);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('rejects a click from someone other than the initiating actor', async () => {
    const interaction = buttonInteraction('rr:c:league-1:player-1:actor-2');

    await expect(handleRankResetInteraction(interaction)).resolves.toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Only the person who ran /rank_reset can use these buttons.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('cancels and removes the confirmation buttons', async () => {
    const interaction = buttonInteraction('rr:x:league-1:player-1:actor-1');

    await expect(handleRankResetInteraction(interaction)).resolves.toBe(true);
    expect(interaction.update).toHaveBeenCalledWith({
      content: 'Rank reset cancelled.',
      components: [],
    });
  });

  it('rechecks eligibility, applies the reset, and refreshes its league leaderboard', async () => {
    const interaction = buttonInteraction('rr:c:league-1:player-1:actor-1');

    await expect(handleRankResetInteraction(interaction)).resolves.toBe(true);

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(playerFindUnique).toHaveBeenCalledWith({ where: { id: 'player-1' } });
    expect(applyRankReset).toHaveBeenCalledWith({
      leagueId: 'league-1',
      actorDiscordId: 'actor-1',
      targetDiscordId: 'target-1',
      memberRoleIds: ['role-1'],
      matchModRoleId: 'mod-role',
      expectedPlayerId: 'player-1',
    });
    expect(refreshLeagueLeaderboard).toHaveBeenCalledWith(interaction.client, 'league-1');
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Reset **Goku**'s rank. Their overall and hero ki have been reset.",
      components: [],
    });
  });

  it('uses self-reset success copy when staff did not override the cooldown', async () => {
    applyRankReset.mockResolvedValue({
      playerId: 'player-1',
      username: 'Goku',
      staffOverride: false,
    });
    const interaction = buttonInteraction('rr:c:league-1:player-1:actor-1');

    await expect(handleRankResetInteraction(interaction)).resolves.toBe(true);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Your rank has been reset. Your overall and hero ki have been reset.',
      components: [],
    });
  });

  it('edits the deferred reply when the confirmation player is no longer linked', async () => {
    playerFindUnique.mockResolvedValue({ id: 'player-1', discordId: null });
    const interaction = buttonInteraction('rr:c:league-1:player-1:actor-1');

    await expect(handleRankResetInteraction(interaction)).resolves.toBe(true);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'That rank reset confirmation is no longer valid.',
      components: [],
    });
    expect(applyRankReset).not.toHaveBeenCalled();
  });

  it.each([
    new RankResetServiceError('Rank reset is disabled for this league.'),
    new MatchServiceError('You do not have permission to manage this match.'),
  ])('shows expected service errors in the deferred reply', async (error) => {
    applyRankReset.mockRejectedValue(error);
    const interaction = buttonInteraction('rr:c:league-1:player-1:actor-1');

    await expect(handleRankResetInteraction(interaction)).resolves.toBe(true);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: error.message,
      components: [],
    });
    expect(refreshLeagueLeaderboard).not.toHaveBeenCalled();
  });
});
