import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  MessageFlags,
} from 'discord.js';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Interaction,
  MessageComponentInteraction,
  ModalSubmitInteraction,
} from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { resolveGuildConfig } from '../../services/guild/index.js';
import {
  assertCanManageMatch,
  getMatchById,
  MatchServiceError,
} from '../../services/match/index.js';
import { canManageMatch } from '../../services/match/match-auth.js';
import {
  buildNewPlayerConfirmCustomId,
  buildNewPlayerDeclineCustomId,
  NEW_PLAYER_PROMPT_PREFIX,
  parseNewPlayerButtonCustomId,
  type NewPlayerSuggestion,
} from '../../services/rating/index.js';
import { ensurePlayerRatings } from '../../services/rating/rating-preview.js';

const log = createLogger('new-player-interactions');

const NOT_YOUR_PROMPT = 'Only the match host or a match moderator can use these buttons.';
const INVALID_PROMPT = 'That New-player prompt is no longer valid.';

export type BuildNewPlayerSuggestComponentsInput = {
  matchId: string;
  playerId: string;
  actorDiscordId: string;
};

export type SendNewPlayerSuggestPromptsInput = {
  interaction:
    | MessageComponentInteraction
    | ModalSubmitInteraction
    | ChatInputCommandInteraction;
  match: { id: string; hostDiscordId: string; leagueId: string };
  suggestions: NewPlayerSuggestion[];
  matchModRoleId?: string;
};

function memberRoleIds(interaction: { member: unknown }): string[] {
  const member = interaction.member;
  if (member instanceof GuildMember) {
    return [...member.roles.cache.keys()];
  }
  if (member && typeof member === 'object' && 'roles' in member) {
    const roles = (member as { roles: unknown }).roles;
    if (Array.isArray(roles)) {
      return roles;
    }
    if (roles && typeof roles === 'object' && 'cache' in roles) {
      const cache = (roles as { cache?: Map<string, unknown> }).cache;
      if (cache instanceof Map) {
        return [...cache.keys()];
      }
    }
  }
  return [];
}

/** Build host-bound Confirm / Decline buttons for a New-player suggest prompt. */
export function buildNewPlayerSuggestComponents(
  input: BuildNewPlayerSuggestComponentsInput,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(
          buildNewPlayerConfirmCustomId(input.matchId, input.playerId, input.actorDiscordId),
        )
        .setLabel('Confirm')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(
          buildNewPlayerDeclineCustomId(input.matchId, input.playerId, input.actorDiscordId),
        )
        .setLabel('Decline')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/** English prompt copy for a New-player suggest. */
export function buildNewPlayerSuggestContent(username: string): string {
  return `Mark **${username}** as New? (host/mod)`;
}

/**
 * After claim/add or PENDING create (`/register_lobby`, wc3stats open), show New-player confirm buttons.
 * Ephemeral when the actor can manage the match; otherwise a public follow-up.
 * Custom ids bind `actorDiscordId` to the match host (mods still authorized on click).
 * One follow-up per suggestion (v1); Discord API failures are logged and do not fail the
 * successful roster claim/add/create.
 */
export async function sendNewPlayerSuggestPrompts(
  input: SendNewPlayerSuggestPromptsInput,
): Promise<void> {
  const { interaction, match, suggestions, matchModRoleId } = input;
  if (suggestions.length === 0) {
    return;
  }

  const actorCanManage = canManageMatch({
    hostDiscordId: match.hostDiscordId,
    actorDiscordId: interaction.user.id,
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId,
  });

  for (const suggestion of suggestions) {
    const content = buildNewPlayerSuggestContent(suggestion.username);
    const components = buildNewPlayerSuggestComponents({
      matchId: suggestion.matchId,
      playerId: suggestion.playerId,
      actorDiscordId: match.hostDiscordId,
    });

    try {
      if (actorCanManage) {
        await interaction.followUp({
          content,
          components,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.followUp({ content, components });
      }
    } catch (error) {
      log.error(
        {
          err: error,
          matchId: match.id,
          playerId: suggestion.playerId,
          actorCanManage,
        },
        'Failed to send New-player suggest prompt',
      );
    }
  }
}

async function loadPlayerUsername(playerId: string): Promise<string | null> {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { username: true },
  });
  return player?.username ?? null;
}

/**
 * Authorize host/mod and return the match (leagueId comes from DB, not the custom id).
 */
async function authorizeNewPlayerClick(
  interaction: ButtonInteraction,
  matchId: string,
): Promise<{ id: string; leagueId: string; hostDiscordId: string }> {
  if (!interaction.guildId) {
    throw new MatchServiceError('This action can only be used in a server.');
  }

  const match = await getMatchById(matchId);
  if (!match) {
    throw new MatchServiceError(INVALID_PROMPT);
  }

  const config = await resolveGuildConfig(interaction.guildId);
  assertCanManageMatch({
    hostDiscordId: match.hostDiscordId,
    actorDiscordId: interaction.user.id,
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId: config.matchModRoleId,
  });

  return match;
}

async function handleConfirm(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseNewPlayerButtonCustomId(interaction.customId);
  if (!parsed || parsed.action !== 'confirm') {
    return;
  }

  await interaction.deferUpdate();

  try {
    const match = await authorizeNewPlayerClick(interaction, parsed.matchId);

    const username = await loadPlayerUsername(parsed.playerId);
    if (!username) {
      await interaction.editReply({
        content: INVALID_PROMPT,
        components: [],
      });
      return;
    }

    await ensurePlayerRatings(match.leagueId, [{ playerId: parsed.playerId, heroId: null }]);
    await prisma.playerRating.update({
      where: {
        leagueId_playerId: { leagueId: match.leagueId, playerId: parsed.playerId },
      },
      data: { isNewPlayer: true },
    });

    await interaction.editReply({
      content: `Marked **${username}** as New. They will not affect team ratings until 5 games.`,
      components: [],
    });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.editReply({ content: error.message, components: [] });
      return;
    }
    throw error;
  }
}

async function handleDecline(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseNewPlayerButtonCustomId(interaction.customId);
  if (!parsed || parsed.action !== 'decline') {
    return;
  }

  await interaction.deferUpdate();

  try {
    await authorizeNewPlayerClick(interaction, parsed.matchId);

    const username = await loadPlayerUsername(parsed.playerId);
    if (!username) {
      await interaction.editReply({
        content: INVALID_PROMPT,
        components: [],
      });
      return;
    }

    await interaction.editReply({
      content: `Kept normal rating for **${username}**.`,
      components: [],
    });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.editReply({ content: error.message, components: [] });
      return;
    }
    throw error;
  }
}

/**
 * Consume New-player Confirm/Decline buttons.
 * Host or match-mod may click (authorize on click via `assertCanManageMatch`).
 */
export async function handleNewPlayerInteraction(interaction: Interaction): Promise<boolean> {
  if (!interaction.isButton() || !interaction.customId.startsWith(NEW_PLAYER_PROMPT_PREFIX)) {
    return false;
  }

  const parsed = parseNewPlayerButtonCustomId(interaction.customId);
  if (!parsed) {
    return true;
  }

  // Spam control: deny non-host/non-mod early without deferring the prompt.
  if (interaction.guildId) {
    const match = await getMatchById(parsed.matchId);
    if (match) {
      const config = await resolveGuildConfig(interaction.guildId);
      const allowed = canManageMatch({
        hostDiscordId: match.hostDiscordId,
        actorDiscordId: interaction.user.id,
        memberRoleIds: memberRoleIds(interaction),
        matchModRoleId: config.matchModRoleId,
      });
      if (!allowed) {
        await interaction.reply({
          content: NOT_YOUR_PROMPT,
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
    }
  }

  if (parsed.action === 'decline') {
    await handleDecline(interaction);
    return true;
  }

  await handleConfirm(interaction);
  return true;
}
