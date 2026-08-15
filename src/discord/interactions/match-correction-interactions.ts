import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  MessageFlags,
} from 'discord.js';
import type { ButtonInteraction, Interaction } from 'discord.js';
import { resolveGuildConfig } from '../../services/guild/index.js';
import { refreshLeagueLeaderboard } from '../../services/leaderboard/index.js';
import {
  assertHasMatchModRole,
  flipCompletedMatch,
  getMatchById,
  MatchServiceError,
  parseMatchCorrectionButtonCustomId,
  buildMatchCorrectionConfirmCustomId,
  buildMatchCorrectionCancelCustomId,
  voidCompletedMatch,
  type MatchCorrectionConfirmInput,
} from '../../services/match/index.js';
import { syncLobbyDiscordMessage } from '../../services/lobby/index.js';

const NOT_YOUR_CORRECTION =
  'Only the moderator who ran this command can use these buttons.';

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

/** Build actor-bound Confirm/Cancel buttons for a match correction prompt. */
export function buildMatchCorrectionConfirmComponents(
  input: MatchCorrectionConfirmInput,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildMatchCorrectionConfirmCustomId(input))
        .setLabel('Confirm')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(buildMatchCorrectionCancelCustomId(input))
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function handleConfirm(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseMatchCorrectionButtonCustomId(interaction.customId);
  if (!parsed || parsed.kind !== 'confirm') {
    return;
  }

  await interaction.deferUpdate();

  if (!interaction.guildId) {
    await interaction.editReply({
      content: 'This action can only be used in a server.',
      components: [],
    });
    return;
  }

  const config = await resolveGuildConfig(interaction.guildId);

  assertHasMatchModRole({
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId: config.matchModRoleId,
  });

  if (parsed.action === 'flip') {
    const updated = await flipCompletedMatch(parsed.matchId, {
      winningTeam: parsed.winningTeam,
      quitterSlots: parsed.quitterSlots,
    });
    await syncLobbyDiscordMessage(interaction.client, updated, 'completed');
    await refreshLeagueLeaderboard(interaction.client, updated.leagueId);
    await interaction.editReply({
      content: `Match \`${updated.id}\` corrected.`,
      components: [],
    });
  } else {
    const updated = await voidCompletedMatch(parsed.matchId);
    await syncLobbyDiscordMessage(interaction.client, updated, 'cancelled', {
      cancelReason: 'by a moderator',
    });
    await refreshLeagueLeaderboard(interaction.client, updated.leagueId);
    await interaction.editReply({
      content: `Match \`${updated.id}\` voided and ratings restored.`,
      components: [],
    });
  }
}

/** Consume and handle matchcorr: Confirm/Cancel button interactions. */
export async function handleMatchCorrectionInteraction(
  interaction: Interaction,
): Promise<boolean> {
  if (!interaction.isButton() || !interaction.customId.startsWith('matchcorr:')) {
    return false;
  }

  const parsed = parseMatchCorrectionButtonCustomId(interaction.customId);
  if (!parsed) {
    return true;
  }

  if (interaction.user.id !== parsed.actorDiscordId) {
    await interaction.reply({
      content: NOT_YOUR_CORRECTION,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (parsed.kind === 'cancel') {
    await interaction.update({
      content: 'Cancelled.',
      components: [],
    });
    return true;
  }

  try {
    await handleConfirm(interaction);
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.editReply({ content: error.message, components: [] });
      return true;
    }
    throw error;
  }

  return true;
}
