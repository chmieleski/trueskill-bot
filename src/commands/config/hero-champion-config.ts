import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  clearHeroChampionHolder,
  setLeagueHeroChampionRole,
  setLeagueHeroChampionRolesEnabled,
  syncHeroChampionRoles,
} from '../../services/hero-champion-roles/index.js';
import {
  respondLeagueAutocomplete,
  withSubcommandLeagueOption,
} from '../../services/league/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import { assertConfigStaff, requireLeagueId } from './config-shared.js';

const log = createLogger('hero_champion_config_cmd');

/**
 * Staff command for #1 hero-ki Discord roles (split from league_config for Discord size limits).
 */
export const data = new SlashCommandBuilder()
  .setName('hero_champion_config')
  .setDescription('Map Discord roles for #1 hero-ki players (UDBR)')
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('enable')
        .setDescription('Turn champion role sync on or off')
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
        .setDescription('Map a Discord role to one hero’s #1 player')
        .addIntegerOption((option) =>
          option
            .setName('hero')
            .setDescription('Hero / lobby slot (1–12)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(12),
        )
        .addRoleOption((option) =>
          option.setName('role').setDescription('Discord role for that hero').setRequired(true),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('unmap')
        .setDescription('Remove the champion role mapping for one hero')
        .addIntegerOption((option) =>
          option
            .setName('hero')
            .setDescription('Hero / lobby slot (1–12)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(12),
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
      await interaction.reply({
        content: error.message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }

  const subcommand = interaction.options.getSubcommand(true);

  if (subcommand === 'enable') {
    const leagueId = await requireLeagueId(interaction);
    if (!leagueId) return;

    const enabled = interaction.options.getBoolean('enabled', true);
    try {
      await setLeagueHeroChampionRolesEnabled(leagueId, enabled);
    } catch (error) {
      if (error instanceof MatchServiceError) {
        await interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      throw error;
    }

    if (enabled) {
      await syncHeroChampionRoles(interaction.client, leagueId);
    }
    log.info(
      { guildId: interaction.guildId, leagueId, enabled, userId: interaction.user.id },
      'Hero champion roles setting updated',
    );
    await interaction.reply({
      content: enabled
        ? 'Hero champion roles enabled. Mapped #1 hero roles will sync after rating changes.'
        : 'Hero champion roles disabled. Existing Discord roles are unchanged until you clear mappings.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'map') {
    const leagueId = await requireLeagueId(interaction);
    if (!leagueId) return;

    const heroId = interaction.options.getInteger('hero', true);
    const role = interaction.options.getRole('role', true);
    try {
      await setLeagueHeroChampionRole(leagueId, heroId, role.id);
    } catch (error) {
      if (error instanceof MatchServiceError) {
        await interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      throw error;
    }

    await syncHeroChampionRoles(interaction.client, leagueId);
    log.info(
      {
        guildId: interaction.guildId,
        leagueId,
        heroId,
        roleId: role.id,
        userId: interaction.user.id,
      },
      'Hero champion role mapping updated',
    );
    await interaction.reply({
      content: `Mapped hero \`${heroId}\` → <@&${role.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'unmap') {
    const leagueId = await requireLeagueId(interaction);
    if (!leagueId) return;

    const heroId = interaction.options.getInteger('hero', true);
    try {
      await clearHeroChampionHolder(interaction.client, leagueId, heroId);
    } catch (error) {
      if (error instanceof MatchServiceError) {
        await interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      throw error;
    }
    log.info(
      { guildId: interaction.guildId, leagueId, heroId, userId: interaction.user.id },
      'Hero champion role mapping cleared',
    );
    await interaction.reply({
      content: `Cleared hero champion role mapping for hero \`${heroId}\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: 'Unknown hero champion config subcommand.',
    flags: MessageFlags.Ephemeral,
  });
}
