import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  applyDecayPreset,
  clearDecayCrunchWindow,
  clearDecayModeSetting,
  clearDecayPrizeLock,
  clearDecayPrizeLockMinGames,
  clearDecayStreakCap,
  respondLeagueAutocomplete,
  setDecayCrunchWindow,
  setDecayModeSetting,
  setDecayPrizeLock,
  setDecayPrizeLockMinGames,
  setDecayStreakCap,
  withSubcommandLeagueOption,
  type DecayMode,
  type DecayTunableKind,
} from '../../services/league/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import { assertConfigStaff, requireWritableLeagueForDecay } from './config-shared.js';

const log = createLogger('decay_config_cmd');

function decayModeChoice() {
  return [
    { name: 'Mid-season', value: 'mid' },
    { name: 'Crunch', value: 'crunch' },
  ] as const;
}

export const data = new SlashCommandBuilder()
  .setName('decay_config')
  .setDescription('Tune per-league idle decay and crunch rates')
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('grace')
        .setDescription('Set mid-season or crunch idle grace days')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('Mid-season or crunch')
            .setRequired(true)
            .addChoices(...decayModeChoice()),
        )
        .addIntegerOption((option) =>
          option
            .setName('days')
            .setDescription('Idle days before decay starts (0–90)')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(90),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('tier1_ki')
        .setDescription('Set tier-1 daily ki loss (mid or crunch)')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('Mid-season or crunch')
            .setRequired(true)
            .addChoices(...decayModeChoice()),
        )
        .addIntegerOption((option) =>
          option
            .setName('ki')
            .setDescription('Ki lost per day in tier 1 (0–500)')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(500),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('tier2_ki')
        .setDescription('Set tier-2+ daily ki loss (mid or crunch)')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('Mid-season or crunch')
            .setRequired(true)
            .addChoices(...decayModeChoice()),
        )
        .addIntegerOption((option) =>
          option
            .setName('ki')
            .setDescription('Ki lost per day in tier 2+ (0–500)')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(500),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('tier1_span')
        .setDescription('Set how many days tier 1 lasts after grace (mid or crunch)')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('Mid-season or crunch')
            .setRequired(true)
            .addChoices(...decayModeChoice()),
        )
        .addIntegerOption((option) =>
          option
            .setName('days')
            .setDescription('Days in tier 1 after grace (0–90)')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(90),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('streak_cap')
        .setDescription('Set mid-season idle streak ki cap (0 = no cap)')
        .addIntegerOption((option) =>
          option
            .setName('ki')
            .setDescription('Max ki lost per idle streak (0–5000; 0 = none)')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(5000),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('crunch_window')
        .setDescription('Set auto-crunch days before season end')
        .addIntegerOption((option) =>
          option
            .setName('days')
            .setDescription('Days before season end when crunch starts (1–90)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(90),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('prize_lock')
        .setDescription('Enable or disable prize-lock medals during crunch')
        .addBooleanOption((option) =>
          option
            .setName('enabled')
            .setDescription('On: medals require a finished-game minimum during crunch')
            .setRequired(true),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('prize_lock_min_games')
        .setDescription('Set finished games required for crunch medals')
        .addIntegerOption((option) =>
          option
            .setName('games')
            .setDescription('Minimum finished non-quit games in the crunch window (1–50)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(50),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('clear_prize_lock_min_games')
        .setDescription('Reset prize-lock min games to the code default (1)'),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('preset')
        .setDescription('Apply a named decay/crunch preset')
        .addStringOption((option) =>
          option.setName('name').setDescription('Preset to apply').setRequired(true).addChoices({
            name: 'Strict crunch (3d/−100ki / 7 games)',
            value: 'strict_crunch',
          }),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('clear_grace')
        .setDescription('Reset mid or crunch grace days to the code default')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('Mid-season or crunch')
            .setRequired(true)
            .addChoices(...decayModeChoice()),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('clear_tier1_ki')
        .setDescription('Reset mid or crunch tier-1 ki/day to the code default')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('Mid-season or crunch')
            .setRequired(true)
            .addChoices(...decayModeChoice()),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('clear_tier2_ki')
        .setDescription('Reset mid or crunch tier-2 ki/day to the code default')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('Mid-season or crunch')
            .setRequired(true)
            .addChoices(...decayModeChoice()),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('clear_tier1_span')
        .setDescription('Reset mid or crunch tier-1 span to the code default')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('Mid-season or crunch')
            .setRequired(true)
            .addChoices(...decayModeChoice()),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('clear_streak_cap')
        .setDescription('Reset mid-season streak cap to default'),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('clear_crunch_window')
        .setDescription('Reset auto-crunch window days to the code default'),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('clear_prize_lock')
        .setDescription('Reset prize-lock toggle to default (on)'),
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

  const leagueId = await requireWritableLeagueForDecay(interaction);
  if (!leagueId) return;

  const subcommand = interaction.options.getSubcommand(true);

  if (
    subcommand === 'grace' ||
    subcommand === 'tier1_ki' ||
    subcommand === 'tier2_ki' ||
    subcommand === 'tier1_span'
  ) {
    const mode = interaction.options.getString('mode', true) as DecayMode;
    const kind = subcommand as DecayTunableKind;

    try {
      if (subcommand === 'grace' || subcommand === 'tier1_span') {
        const days = interaction.options.getInteger('days', true);
        await setDecayModeSetting(leagueId, kind, mode, days);
        await interaction.reply({
          content: `Decay ${kind.replace(/_/g, ' ')} (${mode}) set to \`${days}\`.`,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        const ki = interaction.options.getInteger('ki', true);
        await setDecayModeSetting(leagueId, kind, mode, ki);
        await interaction.reply({
          content: `Decay ${kind.replace(/_/g, ' ')} (${mode}) set to \`${ki}\` ki/day.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (error) {
      if (error instanceof Error) {
        await interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      throw error;
    }

    log.info(
      { guildId: interaction.guildId, leagueId, subcommand, mode, userId: interaction.user.id },
      'Rating decay tunable updated',
    );
    return;
  }

  if (subcommand === 'streak_cap') {
    const ki = interaction.options.getInteger('ki', true);
    try {
      await setDecayStreakCap(leagueId, ki);
    } catch (error) {
      if (error instanceof Error) {
        await interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      throw error;
    }
    log.info(
      { guildId: interaction.guildId, leagueId, ki, userId: interaction.user.id },
      'Rating decay streak cap updated',
    );
    await interaction.reply({
      content:
        ki === 0
          ? 'Mid-season decay streak cap disabled (no cap).'
          : `Mid-season decay streak cap set to \`${ki}\` ki.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'crunch_window') {
    const days = interaction.options.getInteger('days', true);
    try {
      await setDecayCrunchWindow(leagueId, days);
    } catch (error) {
      if (error instanceof Error) {
        await interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      throw error;
    }
    log.info(
      { guildId: interaction.guildId, leagueId, days, userId: interaction.user.id },
      'Rating decay crunch window updated',
    );
    await interaction.reply({
      content: `Auto-crunch window set to \`${days}\` days before season end.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'prize_lock') {
    const enabled = interaction.options.getBoolean('enabled', true);
    await setDecayPrizeLock(leagueId, enabled);
    log.info(
      { guildId: interaction.guildId, leagueId, enabled, userId: interaction.user.id },
      'Rating decay prize lock updated',
    );
    await interaction.reply({
      content: enabled
        ? 'Prize-lock medals enabled during crunch.'
        : 'Prize-lock medals disabled during crunch.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'prize_lock_min_games') {
    const games = interaction.options.getInteger('games', true);
    try {
      await setDecayPrizeLockMinGames(leagueId, games);
    } catch (error) {
      if (error instanceof Error) {
        await interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      throw error;
    }
    log.info(
      { guildId: interaction.guildId, leagueId, games, userId: interaction.user.id },
      'Rating decay prize lock min games updated',
    );
    await interaction.reply({
      content: `Prize-lock minimum set to \`${games}\` finished games.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'clear_prize_lock_min_games') {
    await clearDecayPrizeLockMinGames(leagueId);
    log.info(
      { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
      'Rating decay prize lock min games cleared',
    );
    await interaction.reply({
      content: 'Prize-lock minimum reset to the code default (1).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'preset') {
    const name = interaction.options.getString('name', true);
    try {
      await applyDecayPreset(leagueId, name);
    } catch (error) {
      if (error instanceof Error) {
        await interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      throw error;
    }
    log.info(
      { guildId: interaction.guildId, leagueId, preset: name, userId: interaction.user.id },
      'Rating decay preset applied',
    );
    await interaction.reply({
      content:
        'Applied decay preset `strict_crunch` (crunch grace 3d, −100/−100 ki/day, window 7d, medals need 7 games).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (
    subcommand === 'clear_grace' ||
    subcommand === 'clear_tier1_ki' ||
    subcommand === 'clear_tier2_ki' ||
    subcommand === 'clear_tier1_span'
  ) {
    const mode = interaction.options.getString('mode', true) as DecayMode;
    const kind = (
      {
        clear_grace: 'grace',
        clear_tier1_ki: 'tier1_ki',
        clear_tier2_ki: 'tier2_ki',
        clear_tier1_span: 'tier1_span',
      } as const
    )[subcommand] as DecayTunableKind;

    await clearDecayModeSetting(leagueId, kind, mode);
    log.info(
      { guildId: interaction.guildId, leagueId, subcommand, mode, userId: interaction.user.id },
      'Rating decay tunable cleared',
    );
    await interaction.reply({
      content: `Decay ${kind.replace(/_/g, ' ')} (${mode}) reset to the code default.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'clear_streak_cap') {
    await clearDecayStreakCap(leagueId);
    log.info(
      { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
      'Rating decay streak cap cleared',
    );
    await interaction.reply({
      content: 'Mid-season decay streak cap reset to the code default.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'clear_crunch_window') {
    await clearDecayCrunchWindow(leagueId);
    log.info(
      { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
      'Rating decay crunch window cleared',
    );
    await interaction.reply({
      content: 'Auto-crunch window reset to the code default.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'clear_prize_lock') {
    await clearDecayPrizeLock(leagueId);
    log.info(
      { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
      'Rating decay prize lock cleared',
    );
    await interaction.reply({
      content: 'Prize-lock toggle reset to the code default (on).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: 'Unknown decay config subcommand.',
    flags: MessageFlags.Ephemeral,
  });
}
