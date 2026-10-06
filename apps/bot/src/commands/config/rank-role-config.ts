import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  respondLeagueAutocomplete,
  withSubcommandLeagueOption,
} from '../../services/league/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import {
  clearRankRoleMapping,
  setLeagueRankRole,
  setLeagueRankRolesEnabled,
  syncRankRoles,
} from '../../services/rank-roles/index.js';
import { assertConfigStaff, requireLeagueId } from './config-shared.js';

const log = createLogger('rank_role_config_cmd');

/**
 * Staff command for overall leaderboard #1–#3 Discord roles. Each rank is mapped independently.
 */
export const data = new SlashCommandBuilder()
  .setName('rank_role_config')
  .setDescription('Map Discord roles for leaderboard #1, #2 and #3')
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('enable')
        .setDescription('Turn rank role sync on or off')
        .addBooleanOption((option) =>
          option
            .setName('enabled')
            .setDescription('On: sync after rating changes')
            .setRequired(true),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('map')
        .setDescription('Map a Discord role to one leaderboard position')
        .addIntegerOption((option) =>
          option
            .setName('rank')
            .setDescription('Leaderboard position (1–3)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(3),
        )
        .addRoleOption((option) =>
          option.setName('role').setDescription('Discord role for that rank').setRequired(true),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('unmap')
        .setDescription('Remove the role mapping for one leaderboard position')
        .addIntegerOption((option) =>
          option
            .setName('rank')
            .setDescription('Leaderboard position (1–3)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(3),
        ),
    ),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondLeagueAutocomplete(interaction);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: 'This command can only be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    assertConfigStaff(interaction);
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral });
      return;
    }
    throw error;
  }

  const subcommand = interaction.options.getSubcommand(true);
  const leagueId = await requireLeagueId(interaction);
  if (!leagueId) return;

  // Defer before DB + Discord sync: Discord requires an ack within ~3s.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let content: string;
  try {
    if (subcommand === 'enable') {
      const enabled = interaction.options.getBoolean('enabled', true);
      await setLeagueRankRolesEnabled(leagueId, enabled);
      if (enabled) await syncRankRoles(interaction.client, leagueId);
      content = enabled
        ? 'Rank roles enabled. Mapped leaderboard roles will sync after rating changes.'
        : 'Rank roles disabled. Existing Discord roles are unchanged until you clear mappings.';
    } else if (subcommand === 'map') {
      const rank = interaction.options.getInteger('rank', true);
      const role = interaction.options.getRole('role', true);
      await setLeagueRankRole(leagueId, rank, role.id);
      await syncRankRoles(interaction.client, leagueId);
      content = `Mapped leaderboard #${rank} → <@&${role.id}>.`;
    } else if (subcommand === 'unmap') {
      const rank = interaction.options.getInteger('rank', true);
      await clearRankRoleMapping(interaction.client, leagueId, rank);
      content = `Cleared the role mapping for leaderboard #${rank}.`;
    } else {
      content = 'Unknown rank role config subcommand.';
    }
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    throw error;
  }

  log.info(
    { guildId: interaction.guildId, leagueId, subcommand, userId: interaction.user.id },
    'Rank role config updated',
  );
  await interaction.editReply({ content });
}
