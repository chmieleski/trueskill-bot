import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import type { ButtonInteraction, Interaction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  stripHeroChampionDiscordRoles,
  syncHeroChampionRoles,
} from '../../services/hero-champion-roles/index.js';
import { syncRankRoles } from '../../services/rank-roles/index.js';
import { deleteMessageBestEffort, setupLiveLeaderboard } from '../../services/leaderboard/index.js';
import {
  applyLeagueRollover,
  buildRolloverCancelCustomId,
  buildRolloverConfirmCustomId,
  cancelLeagueRolloverDraft,
  getLeagueById,
  LeagueRolloverError,
  parseRolloverButtonCustomId,
  type LeagueRolloverResult,
} from '../../services/league/index.js';

const log = createLogger('league_rollover_interactions');

const NOT_YOUR_ROLLOVER = 'Only the person who ran /league rollover can use these buttons.';

const DUPLICATE_LEAGUE_NAME_MESSAGE =
  'A league with that name already exists for this game on this server.';

function buildRolloverSuccessMessage(result: LeagueRolloverResult): string {
  const resetLine =
    result.resetMode === 'soft' && result.compression !== null
      ? `soft (compression ${result.compression})`
      : result.resetMode;

  return [
    'Rollover complete.',
    `• Archived: **${result.archivedLeagueName}** (\`${result.archivedLeagueId}\`)`,
    `• Successor: **${result.successorLeagueName}** (\`${result.successorLeagueId}\`)`,
    `• Reset: ${resetLine}`,
    `• Players seeded: ${result.playersSeeded}`,
    `• Bindings moved: ${result.bindingsMoved}`,
  ].join('\n');
}

/** Build actor-bound Confirm/Cancel buttons for a league rollover preview. */
export function buildRolloverConfirmComponents(input: {
  draftId: string;
  actorDiscordId: string;
}): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildRolloverConfirmCustomId(input.draftId, input.actorDiscordId))
        .setLabel('Confirm rollover')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(buildRolloverCancelCustomId(input.draftId, input.actorDiscordId))
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/**
 * After DB rollover: strip archived hero champion / rank role holders, then sync successor mappings.
 * Best-effort — never fails the rollover reply.
 */
async function syncChampionRolesAfterRollover(
  interaction: ButtonInteraction,
  result: LeagueRolloverResult,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    return;
  }

  if (result.archivedChampionRoleHolders.length > 0) {
    try {
      await stripHeroChampionDiscordRoles(
        interaction.client,
        guildId,
        result.archivedChampionRoleHolders,
      );
    } catch (error) {
      log.warn(
        { err: error, archivedLeagueId: result.archivedLeagueId },
        'Failed to strip archived hero champion Discord roles',
      );
    }
  }

  try {
    await syncHeroChampionRoles(interaction.client, result.successorLeagueId);
  } catch (error) {
    log.warn(
      { err: error, successorLeagueId: result.successorLeagueId },
      'Failed to sync successor hero champion roles after rollover',
    );
  }

  try {
    await syncRankRoles(interaction.client, result.successorLeagueId);
  } catch (error) {
    log.warn(
      { err: error, successorLeagueId: result.successorLeagueId },
      'Failed to sync successor rank roles after rollover',
    );
  }
}

async function handleConfirm(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseRolloverButtonCustomId(interaction.customId);
  if (!parsed || parsed.action !== 'confirm') {
    return;
  }

  await interaction.deferUpdate();

  try {
    const result = await applyLeagueRollover({
      draftId: parsed.draftId,
      actorDiscordId: parsed.actorDiscordId,
    });

    if (result.sourceLeaderboardChannelId && result.sourceLeaderboardMessageId) {
      await deleteMessageBestEffort(
        interaction.client,
        result.sourceLeaderboardChannelId,
        result.sourceLeaderboardMessageId,
      );
    }

    const successor = await getLeagueById(result.successorLeagueId);
    if (successor?.leaderboardChannelId) {
      await setupLiveLeaderboard(
        interaction.client,
        result.successorLeagueId,
        successor.leaderboardChannelId,
      );
    }

    await syncChampionRolesAfterRollover(interaction, result);

    await interaction.editReply({
      content: buildRolloverSuccessMessage(result),
      components: [],
    });
  } catch (error) {
    if (error instanceof LeagueRolloverError) {
      await interaction.editReply({ content: error.message, components: [] });
      return;
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      await interaction.editReply({
        content: DUPLICATE_LEAGUE_NAME_MESSAGE,
        components: [],
      });
      return;
    }
    throw error;
  }
}

/** Consume and handle league rollover Confirm/Cancel button interactions. */
export async function handleLeagueRolloverInteraction(interaction: Interaction): Promise<boolean> {
  if (!interaction.isButton() || !interaction.customId.startsWith('lv:')) {
    return false;
  }

  const parsed = parseRolloverButtonCustomId(interaction.customId);
  if (!parsed) {
    return true;
  }

  if (interaction.user.id !== parsed.actorDiscordId) {
    await interaction.reply({
      content: NOT_YOUR_ROLLOVER,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (parsed.action === 'cancel') {
    try {
      await cancelLeagueRolloverDraft(parsed.draftId, parsed.actorDiscordId);
    } catch (error) {
      if (error instanceof LeagueRolloverError) {
        await interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      throw error;
    }

    await interaction.update({
      content: 'Rollover cancelled.',
      components: [],
    });
    return true;
  }

  await handleConfirm(interaction);
  return true;
}
