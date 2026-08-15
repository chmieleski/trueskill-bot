import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  MessageFlags,
} from 'discord.js';
import type { ButtonInteraction, Interaction } from 'discord.js';
import { prisma } from '../../lib/prisma.js';
import { resolveGuildConfig } from '../../services/guild/index.js';
import { refreshLeagueLeaderboard } from '../../services/leaderboard/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import {
  applyRankReset,
  buildRankResetCancelCustomId,
  buildRankResetConfirmCustomId,
  parseRankResetButtonCustomId,
  RankResetServiceError,
} from '../../services/rating/index.js';

const NOT_YOUR_RESET =
  'Only the person who ran /rank_reset can use these buttons.';
const INVALID_CONFIRMATION =
  'That rank reset confirmation is no longer valid.';

export type BuildRankResetConfirmComponentsInput = {
  leagueId: string;
  playerId: string;
  actorDiscordId: string;
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

/** Build actor-bound buttons for a rank-reset confirmation prompt. */
export function buildRankResetConfirmComponents(
  input: BuildRankResetConfirmComponentsInput,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(
          buildRankResetConfirmCustomId(
            input.leagueId,
            input.playerId,
            input.actorDiscordId,
          ),
        )
        .setLabel('Confirm reset')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(
          buildRankResetCancelCustomId(
            input.leagueId,
            input.playerId,
            input.actorDiscordId,
          ),
        )
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function handleConfirm(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseRankResetButtonCustomId(interaction.customId);
  if (!parsed || parsed.action !== 'confirm') {
    return;
  }

  await interaction.deferUpdate();

  try {
    if (!interaction.guildId) {
      throw new MatchServiceError('This action can only be used in a server.');
    }

    const player = await prisma.player.findUnique({
      where: { id: parsed.playerId },
    });
    if (!player?.discordId) {
      await interaction.editReply({
        content: INVALID_CONFIRMATION,
        components: [],
      });
      return;
    }

    const config = await resolveGuildConfig(interaction.guildId);
    const result = await applyRankReset({
      leagueId: parsed.leagueId,
      actorDiscordId: parsed.actorDiscordId,
      targetDiscordId: player.discordId,
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: config.matchModRoleId,
      expectedPlayerId: parsed.playerId,
    });

    await refreshLeagueLeaderboard(interaction.client, parsed.leagueId);
    await interaction.editReply({
      content: result.staffOverride
        ? `Reset **${result.username}**'s rank. Their overall and hero ki have been reset.`
        : 'Your rank has been reset. Your overall and hero ki have been reset.',
      components: [],
    });
  } catch (error) {
    if (
      error instanceof RankResetServiceError ||
      error instanceof MatchServiceError
    ) {
      await interaction.editReply({ content: error.message, components: [] });
      return;
    }
    throw error;
  }
}

/** Consume and handle rank-reset Confirm/Cancel button interactions. */
export async function handleRankResetInteraction(
  interaction: Interaction,
): Promise<boolean> {
  if (!interaction.isButton() || !interaction.customId.startsWith('rr:')) {
    return false;
  }

  const parsed = parseRankResetButtonCustomId(interaction.customId);
  if (!parsed) {
    return true;
  }

  if (interaction.user.id !== parsed.actorDiscordId) {
    await interaction.reply({
      content: NOT_YOUR_RESET,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (parsed.action === 'cancel') {
    await interaction.update({
      content: 'Rank reset cancelled.',
      components: [],
    });
    return true;
  }

  await handleConfirm(interaction);
  return true;
}
