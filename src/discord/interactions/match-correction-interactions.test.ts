import type { Interaction } from 'discord.js';
import { ButtonStyle, MessageFlags } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  assertHasMatchModRole,
  flipCompletedMatch,
  parseMatchCorrectionButtonCustomId,
  buildMatchCorrectionConfirmCustomId,
  buildMatchCorrectionCancelCustomId,
  voidCompletedMatch,
  refreshLeagueLeaderboard,
  resolveGuildConfig,
  syncLobbyDiscordMessage,
} = vi.hoisted(() => ({
  assertHasMatchModRole: vi.fn(),
  flipCompletedMatch: vi.fn(),
  parseMatchCorrectionButtonCustomId: vi.fn(),
  buildMatchCorrectionConfirmCustomId: vi.fn(),
  buildMatchCorrectionCancelCustomId: vi.fn(),
  voidCompletedMatch: vi.fn(),
  refreshLeagueLeaderboard: vi.fn(),
  resolveGuildConfig: vi.fn(),
  syncLobbyDiscordMessage: vi.fn(),
}));

vi.mock('../../services/match/index.js', () => {
  class MatchServiceError extends Error {}
  const buildCustomId = (
    kind: 'ok' | 'no',
    action: 'f' | 'v',
    matchId: string,
    actorDiscordId: string,
    extra = '',
  ) =>
    action === 'f'
      ? `matchcorr:${kind}:f:${matchId}:${actorDiscordId}:1:${extra}`
      : `matchcorr:${kind}:v:${matchId}:${actorDiscordId}`;

  return {
    assertHasMatchModRole,
    flipCompletedMatch,
    parseMatchCorrectionButtonCustomId,
    buildMatchCorrectionConfirmCustomId: (input: { action: string; matchId: string; actorDiscordId: string }) =>
      buildCustomId('ok', input.action === 'flip' ? 'f' : 'v', input.matchId, input.actorDiscordId),
    buildMatchCorrectionCancelCustomId: (input: { action: string; matchId: string; actorDiscordId: string }) =>
      buildCustomId('no', input.action === 'flip' ? 'f' : 'v', input.matchId, input.actorDiscordId),
    voidCompletedMatch,
    MatchServiceError,
  };
});

vi.mock('../../services/leaderboard/index.js', () => ({
  refreshLeagueLeaderboard,
}));

vi.mock('../../services/guild/index.js', () => ({
  resolveGuildConfig,
}));

vi.mock('../../services/lobby/index.js', () => ({
  syncLobbyDiscordMessage,
}));

import {
  buildMatchCorrectionConfirmComponents,
  handleMatchCorrectionInteraction,
} from './match-correction-interactions.js';
import { MatchServiceError } from '../../services/match/index.js';

function buttonInteraction(
  customId: string,
  overrides: Record<string, unknown> = {},
): Interaction {
  return {
    isButton: () => true,
    customId,
    user: { id: 'actor-1' },
    guildId: 'guild-1',
    member: { roles: ['mod-role'] },
    client: { user: { id: 'bot-1' } },
    reply: vi.fn(),
    update: vi.fn(),
    deferUpdate: vi.fn(),
    editReply: vi.fn(),
    ...overrides,
  } as unknown as Interaction;
}

const FLIP_CONFIRM_ID = 'matchcorr:ok:f:match-1:actor-1:1:';
const FLIP_CANCEL_ID = 'matchcorr:no:f:match-1:actor-1:1:';
const VOID_CONFIRM_ID = 'matchcorr:ok:v:match-1:actor-1';
const VOID_CANCEL_ID = 'matchcorr:no:v:match-1:actor-1';

describe('buildMatchCorrectionConfirmComponents', () => {
  beforeEach(() => {
    buildMatchCorrectionConfirmCustomId.mockReturnValue(FLIP_CONFIRM_ID);
    buildMatchCorrectionCancelCustomId.mockReturnValue(FLIP_CANCEL_ID);
  });

  it('builds Confirm and Cancel buttons', () => {
    const [row] = buildMatchCorrectionConfirmComponents({
      action: 'flip',
      matchId: 'match-1',
      actorDiscordId: 'actor-1',
      winningTeam: 1,
      quitterSlots: [],
    });

    expect(row?.toJSON()).toEqual({
      type: 1,
      components: [
        {
          type: 2,
          custom_id: FLIP_CONFIRM_ID,
          label: 'Confirm',
          style: ButtonStyle.Danger,
        },
        {
          type: 2,
          custom_id: FLIP_CANCEL_ID,
          label: 'Cancel',
          style: ButtonStyle.Secondary,
        },
      ],
    });
  });
});

describe('handleMatchCorrectionInteraction', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resolveGuildConfig.mockResolvedValue({ matchModRoleId: 'mod-role' });
    flipCompletedMatch.mockResolvedValue({
      match: { id: 'match-1', leagueId: 'league-1', players: [] },
      ratingPreview: { players: [] },
    });
    voidCompletedMatch.mockResolvedValue({ id: 'match-1', leagueId: 'league-1', players: [] });
    parseMatchCorrectionButtonCustomId.mockImplementation((customId: string) => {
      if (!customId.startsWith('matchcorr:')) return null;
      const parts = customId.split(':');
      const kind = parts[1] === 'ok' ? 'confirm' : 'cancel';
      const actionCode = parts[2];
      if (actionCode === 'f') {
        return {
          kind,
          action: 'flip',
          matchId: parts[3],
          actorDiscordId: parts[4],
          winningTeam: 1 as 1 | 2,
          quitterSlots: [],
        };
      }
      if (actionCode === 'v') {
        return {
          kind,
          action: 'void',
          matchId: parts[3],
          actorDiscordId: parts[4],
        };
      }
      return null;
    });
  });

  it('ignores unrelated interactions', async () => {
    const interaction = buttonInteraction('leaderboard:overall:1');

    await expect(handleMatchCorrectionInteraction(interaction)).resolves.toBe(false);
  });

  it('consumes malformed matchcorr button IDs', async () => {
    parseMatchCorrectionButtonCustomId.mockReturnValue(null);
    const interaction = buttonInteraction('matchcorr:garbage');

    await expect(handleMatchCorrectionInteraction(interaction)).resolves.toBe(true);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('rejects a click from someone other than the initiating actor', async () => {
    const interaction = buttonInteraction(FLIP_CONFIRM_ID, { user: { id: 'other-actor' } });

    await expect(handleMatchCorrectionInteraction(interaction)).resolves.toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Only the moderator who ran this command can use these buttons.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('cancels and removes buttons on cancel flip', async () => {
    const interaction = buttonInteraction(FLIP_CANCEL_ID);

    await expect(handleMatchCorrectionInteraction(interaction)).resolves.toBe(true);
    expect(interaction.update).toHaveBeenCalledWith({
      content: 'Cancelled.',
      components: [],
    });
  });

  it('cancels and removes buttons on cancel void', async () => {
    const interaction = buttonInteraction(VOID_CANCEL_ID);

    await expect(handleMatchCorrectionInteraction(interaction)).resolves.toBe(true);
    expect(interaction.update).toHaveBeenCalledWith({
      content: 'Cancelled.',
      components: [],
    });
  });

  it('re-asserts mod role, flips match, syncs Discord, refreshes leaderboard', async () => {
    const interaction = buttonInteraction(FLIP_CONFIRM_ID);

    await expect(handleMatchCorrectionInteraction(interaction)).resolves.toBe(true);

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(assertHasMatchModRole).toHaveBeenCalledWith({
      actorDiscordId: 'actor-1',
      memberRoleIds: ['mod-role'],
      matchModRoleId: 'mod-role',
    });
    expect(flipCompletedMatch).toHaveBeenCalledWith('match-1', 1, []);
    expect(syncLobbyDiscordMessage).toHaveBeenCalledWith(
      interaction.client,
      { id: 'match-1', leagueId: 'league-1', players: [] },
      'completed',
      { ratingPreview: { players: [] } },
    );
    expect(refreshLeagueLeaderboard).toHaveBeenCalledWith(interaction.client, 'league-1');
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Match `match-1` corrected.',
      components: [],
    });
  });

  it('re-asserts mod role, voids match, syncs Discord with cancelReason, refreshes leaderboard', async () => {
    const interaction = buttonInteraction(VOID_CONFIRM_ID);

    await expect(handleMatchCorrectionInteraction(interaction)).resolves.toBe(true);

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(assertHasMatchModRole).toHaveBeenCalledWith({
      actorDiscordId: 'actor-1',
      memberRoleIds: ['mod-role'],
      matchModRoleId: 'mod-role',
    });
    expect(voidCompletedMatch).toHaveBeenCalledWith('match-1');
    expect(syncLobbyDiscordMessage).toHaveBeenCalledWith(
      interaction.client,
      { id: 'match-1', leagueId: 'league-1', players: [] },
      'cancelled',
      { cancelReason: 'by a moderator' },
    );
    expect(refreshLeagueLeaderboard).toHaveBeenCalledWith(interaction.client, 'league-1');
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Match `match-1` voided and ratings restored.',
      components: [],
    });
  });

  it('shows MatchServiceError in deferred reply on confirm', async () => {
    const error = new MatchServiceError('Match no longer correctable.');
    flipCompletedMatch.mockRejectedValue(error);
    const interaction = buttonInteraction(FLIP_CONFIRM_ID);

    await expect(handleMatchCorrectionInteraction(interaction)).resolves.toBe(true);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Match no longer correctable.',
      components: [],
    });
    expect(refreshLeagueLeaderboard).not.toHaveBeenCalled();
  });
});
