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

import {
  buildNewPlayerConfirmCustomId,
  buildNewPlayerDeclineCustomId,
  parseNewPlayerButtonCustomId,
} from '../../services/rating/new-player.js';
import {
  buildNewPlayerSuggestComponents,
  buildNewPlayerSuggestContent,
  handleNewPlayerInteraction,
} from './new-player-interactions.js';
import { MatchServiceError } from '../../services/match/index.js';

const MATCH_ID = 'clxxxxxxxxxxxxxxxxxxxxxxx';
const PLAYER_ID = '550e8400-e29b-41d4-a716-446655440000';
const HOST_ID = '1234567890123456789';
const LEAGUE_ID = 'league-1';

function buttonInteraction(customId: string, overrides: Record<string, unknown> = {}): Interaction {
  return {
    isButton: () => true,
    customId,
    user: { id: HOST_ID },
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
  it('builds confirm and decline buttons under Discord 100-char limit', () => {
    const confirmId = buildNewPlayerConfirmCustomId(MATCH_ID, PLAYER_ID, HOST_ID);
    const declineId = buildNewPlayerDeclineCustomId(MATCH_ID, PLAYER_ID, HOST_ID);

    expect(confirmId.length).toBeLessThanOrEqual(100);
    expect(declineId.length).toBeLessThanOrEqual(100);
    expect(parseNewPlayerButtonCustomId(confirmId)).toEqual({
      action: 'confirm',
      matchId: MATCH_ID,
      playerId: PLAYER_ID,
      actorDiscordId: HOST_ID,
    });

    const [row] = buildNewPlayerSuggestComponents({
      matchId: MATCH_ID,
      playerId: PLAYER_ID,
      actorDiscordId: HOST_ID,
    });

    expect(row?.toJSON()).toEqual({
      type: 1,
      components: [
        {
          type: 2,
          custom_id: confirmId,
          label: 'Confirm',
          style: ButtonStyle.Success,
        },
        {
          type: 2,
          custom_id: declineId,
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
      id: MATCH_ID,
      leagueId: LEAGUE_ID,
      hostDiscordId: HOST_ID,
    });
    resolveGuildConfig.mockResolvedValue({ matchModRoleId: 'mod-role' });
    canManageMatch.mockReturnValue(true);
    assertCanManageMatch.mockImplementation(() => undefined);
    playerFindUnique.mockResolvedValue({ id: PLAYER_ID, username: 'Goku' });
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
    const customId = buildNewPlayerConfirmCustomId(MATCH_ID, PLAYER_ID, HOST_ID);
    const interaction = buttonInteraction(customId, {
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
    const customId = buildNewPlayerConfirmCustomId(MATCH_ID, PLAYER_ID, HOST_ID);
    const interaction = buttonInteraction(customId, {
      user: { id: 'mod-1' },
      member: { roles: ['mod-role'] },
    });

    await expect(handleNewPlayerInteraction(interaction)).resolves.toBe(true);

    expect(assertCanManageMatch).toHaveBeenCalledWith({
      hostDiscordId: HOST_ID,
      actorDiscordId: 'mod-1',
      memberRoleIds: ['mod-role'],
      matchModRoleId: 'mod-role',
    });
    expect(ensurePlayerRatings).toHaveBeenCalledWith(LEAGUE_ID, [
      { playerId: PLAYER_ID, heroId: null },
    ]);
    expect(playerRatingUpdate).toHaveBeenCalledWith({
      where: {
        leagueId_playerId: { leagueId: LEAGUE_ID, playerId: PLAYER_ID },
      },
      data: { isNewPlayer: true },
    });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Marked **Goku** as New. They will not affect team ratings until 5 games.',
      components: [],
    });
  });

  it('declines without changing the New flag', async () => {
    const customId = buildNewPlayerDeclineCustomId(MATCH_ID, PLAYER_ID, HOST_ID);
    const interaction = buttonInteraction(customId);

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
    const customId = buildNewPlayerConfirmCustomId(MATCH_ID, PLAYER_ID, HOST_ID);
    const interaction = buttonInteraction(customId);

    await expect(handleNewPlayerInteraction(interaction)).resolves.toBe(true);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Only the match host or a match moderator can do that.',
      components: [],
    });
    expect(playerRatingUpdate).not.toHaveBeenCalled();
  });
});
