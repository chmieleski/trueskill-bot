import type { Interaction } from 'discord.js';
import { ButtonStyle, MessageFlags } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  assertCanManageMatch,
  canManageMatch,
  ensurePlayerRatings,
  getMatchById,
  playerFindUnique,
  playerRatingUpdate,
  resolveGuildConfig,
} = vi.hoisted(() => ({
  assertCanManageMatch: vi.fn(),
  canManageMatch: vi.fn(),
  ensurePlayerRatings: vi.fn(),
  getMatchById: vi.fn(),
  playerFindUnique: vi.fn(),
  playerRatingUpdate: vi.fn(),
  resolveGuildConfig: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    player: { findUnique: playerFindUnique },
    playerRating: { update: playerRatingUpdate },
  },
}));

vi.mock('../../services/guild/index.js', () => ({
  resolveGuildConfig,
}));

vi.mock('../../services/match/index.js', () => {
  class MatchServiceError extends Error {}
  return {
    MatchServiceError,
    assertCanManageMatch,
    getMatchById,
  };
});

vi.mock('../../services/match/match-auth.js', () => ({
  canManageMatch,
}));

vi.mock('../../services/rating/rating-preview.js', () => ({
  ensurePlayerRatings,
}));

vi.mock('../../services/rating/index.js', () => {
  const buildCustomId = (
    action: 'confirm' | 'decline',
    matchId: string,
    leagueId: string,
    playerId: string,
    actorDiscordId: string,
  ) => `np:${action}:${matchId}:${leagueId}:${playerId}:${actorDiscordId}`;

  return {
    NEW_PLAYER_PROMPT_PREFIX: 'np:',
    buildNewPlayerConfirmCustomId: (
      matchId: string,
      leagueId: string,
      playerId: string,
      actorDiscordId: string,
    ) => buildCustomId('confirm', matchId, leagueId, playerId, actorDiscordId),
    buildNewPlayerDeclineCustomId: (
      matchId: string,
      leagueId: string,
      playerId: string,
      actorDiscordId: string,
    ) => buildCustomId('decline', matchId, leagueId, playerId, actorDiscordId),
    parseNewPlayerButtonCustomId: (customId: string) => {
      const [prefix, action, matchId, leagueId, playerId, actorDiscordId, extra] =
        customId.split(':');
      if (
        prefix !== 'np' ||
        (action !== 'confirm' && action !== 'decline') ||
        !matchId ||
        !leagueId ||
        !playerId ||
        !actorDiscordId ||
        extra !== undefined
      ) {
        return null;
      }
      return { action, matchId, leagueId, playerId, actorDiscordId };
    },
  };
});

import {
  buildNewPlayerSuggestComponents,
  buildNewPlayerSuggestContent,
  handleNewPlayerInteraction,
} from './new-player-interactions.js';
import { MatchServiceError } from '../../services/match/index.js';

function buttonInteraction(customId: string, overrides: Record<string, unknown> = {}): Interaction {
  return {
    isButton: () => true,
    customId,
    user: { id: 'host-1' },
    guildId: 'guild-1',
    member: { roles: ['role-1'] },
    client: { user: { id: 'bot-1' } },
    reply: vi.fn(),
    update: vi.fn(),
    deferUpdate: vi.fn(),
    editReply: vi.fn(),
    followUp: vi.fn(),
    ...overrides,
  } as unknown as Interaction;
}

describe('buildNewPlayerSuggestComponents', () => {
  it('builds confirm and decline buttons bound to the host actor', () => {
    const [row] = buildNewPlayerSuggestComponents({
      matchId: 'match-1',
      leagueId: 'league-1',
      playerId: 'player-1',
      actorDiscordId: 'host-1',
    });

    expect(row?.toJSON()).toEqual({
      type: 1,
      components: [
        {
          type: 2,
          custom_id: 'np:confirm:match-1:league-1:player-1:host-1',
          label: 'Confirm',
          style: ButtonStyle.Success,
        },
        {
          type: 2,
          custom_id: 'np:decline:match-1:league-1:player-1:host-1',
          label: 'Decline',
          style: ButtonStyle.Secondary,
        },
      ],
    });
  });
});

describe('buildNewPlayerSuggestContent', () => {
  it('asks host/mod to mark the player as New', () => {
    expect(buildNewPlayerSuggestContent('Goku')).toBe('Mark **Goku** as New? (host/mod)');
  });
});

describe('handleNewPlayerInteraction', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getMatchById.mockResolvedValue({
      id: 'match-1',
      leagueId: 'league-1',
      hostDiscordId: 'host-1',
    });
    resolveGuildConfig.mockResolvedValue({ matchModRoleId: 'mod-role' });
    canManageMatch.mockReturnValue(true);
    assertCanManageMatch.mockImplementation(() => undefined);
    playerFindUnique.mockResolvedValue({ id: 'player-1', username: 'Goku' });
    ensurePlayerRatings.mockResolvedValue(undefined);
    playerRatingUpdate.mockResolvedValue({});
  });

  it('ignores unrelated interactions', async () => {
    const interaction = buttonInteraction('leaderboard:overall:1');

    await expect(handleNewPlayerInteraction(interaction)).resolves.toBe(false);
  });

  it('consumes malformed new-player button IDs', async () => {
    const interaction = buttonInteraction('np:invalid');

    await expect(handleNewPlayerInteraction(interaction)).resolves.toBe(true);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('rejects a click from someone who cannot manage the match', async () => {
    canManageMatch.mockReturnValue(false);
    const interaction = buttonInteraction('np:confirm:match-1:league-1:player-1:host-1', {
      user: { id: 'random-1' },
    });

    await expect(handleNewPlayerInteraction(interaction)).resolves.toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Only the match host or a match moderator can use these buttons.',
      flags: MessageFlags.Ephemeral,
    });
    expect(ensurePlayerRatings).not.toHaveBeenCalled();
  });

  it('allows a mod to confirm even when the custom id actor is the host', async () => {
    const interaction = buttonInteraction('np:confirm:match-1:league-1:player-1:host-1', {
      user: { id: 'mod-1' },
      member: { roles: ['mod-role'] },
    });

    await expect(handleNewPlayerInteraction(interaction)).resolves.toBe(true);

    expect(assertCanManageMatch).toHaveBeenCalledWith({
      hostDiscordId: 'host-1',
      actorDiscordId: 'mod-1',
      memberRoleIds: ['mod-role'],
      matchModRoleId: 'mod-role',
    });
    expect(ensurePlayerRatings).toHaveBeenCalledWith('league-1', [
      { playerId: 'player-1', heroId: null },
    ]);
    expect(playerRatingUpdate).toHaveBeenCalledWith({
      where: {
        leagueId_playerId: { leagueId: 'league-1', playerId: 'player-1' },
      },
      data: { isNewPlayer: true },
    });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Marked **Goku** as New. They will not affect team ratings until 5 games.',
      components: [],
    });
  });

  it('declines without changing the New flag', async () => {
    const interaction = buttonInteraction('np:decline:match-1:league-1:player-1:host-1');

    await expect(handleNewPlayerInteraction(interaction)).resolves.toBe(true);
    expect(playerRatingUpdate).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Kept normal rating for **Goku**.',
      components: [],
    });
  });

  it('shows MatchServiceError messages in the deferred reply', async () => {
    assertCanManageMatch.mockImplementation(() => {
      throw new MatchServiceError('Only the match host or a match moderator can do that.');
    });
    const interaction = buttonInteraction('np:confirm:match-1:league-1:player-1:host-1');

    await expect(handleNewPlayerInteraction(interaction)).resolves.toBe(true);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Only the match host or a match moderator can do that.',
      components: [],
    });
    expect(playerRatingUpdate).not.toHaveBeenCalled();
  });
});
