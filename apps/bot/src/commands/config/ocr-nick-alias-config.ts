import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  clearAllLeagueOcrNickAliases,
  clearLeagueOcrNickAlias,
  formatOcrNickAliasLines,
  listLeagueOcrNickAliases,
  setLeagueOcrNickAlias,
} from '../../services/lobby/ocr-nick-aliases.js';
import {
  respondLeagueAutocomplete,
  withSubcommandLeagueOption,
} from '../../services/league/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import { assertConfigStaff, requireLeagueId } from './config-shared.js';

const log = createLogger('ocr_nick_alias_config_cmd');

/**
 * Staff command for OCR nick aliases (split from league_config for Discord size limits).
 */
export const data = new SlashCommandBuilder()
  .setName('ocr_nick_alias_config')
  .setDescription('Map OCR misread nicks to the correct in-game nick')
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('set')
        .setDescription('Map a wrong OCR nick to the correct nick')
        .addStringOption((option) =>
          option
            .setName('from')
            .setDescription('Wrong nick as OCR usually reads it')
            .setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('to').setDescription('Correct in-game nick').setRequired(true),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('clear')
        .setDescription('Remove one OCR nick alias')
        .addStringOption((option) =>
          option.setName('from').setDescription('Wrong nick alias key to remove').setRequired(true),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand.setName('clear_all').setDescription('Remove all OCR nick aliases for this league'),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand.setName('list').setDescription('List OCR nick aliases for this league'),
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

  if (subcommand === 'set') {
    const leagueId = await requireLeagueId(interaction);
    if (!leagueId) return;

    const from = interaction.options.getString('from', true);
    const to = interaction.options.getString('to', true);
    try {
      const alias = await setLeagueOcrNickAlias(leagueId, from, to);
      log.info(
        {
          guildId: interaction.guildId,
          leagueId,
          fromNick: alias.fromNick,
          toNick: alias.toNick,
          userId: interaction.user.id,
        },
        'OCR nick alias upserted',
      );
      await interaction.reply({
        content: `OCR nick alias set: \`${alias.fromNick}\` → \`${alias.toNick}\`.`,
        flags: MessageFlags.Ephemeral,
      });
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
    return;
  }

  if (subcommand === 'clear') {
    const leagueId = await requireLeagueId(interaction);
    if (!leagueId) return;

    const from = interaction.options.getString('from', true);
    try {
      const removed = await clearLeagueOcrNickAlias(leagueId, from);
      log.info(
        {
          guildId: interaction.guildId,
          leagueId,
          from,
          removed,
          userId: interaction.user.id,
        },
        'OCR nick alias cleared',
      );
      await interaction.reply({
        content: removed
          ? `Cleared OCR nick alias for \`${from}\`.`
          : `No OCR nick alias found for \`${from}\`.`,
        flags: MessageFlags.Ephemeral,
      });
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
    return;
  }

  if (subcommand === 'clear_all') {
    const leagueId = await requireLeagueId(interaction);
    if (!leagueId) return;

    const removed = await clearAllLeagueOcrNickAliases(leagueId);
    log.info(
      { guildId: interaction.guildId, leagueId, removed, userId: interaction.user.id },
      'OCR nick aliases cleared',
    );
    await interaction.reply({
      content:
        removed === 0
          ? 'No OCR nick aliases to clear.'
          : `Cleared ${removed} OCR nick alias${removed === 1 ? '' : 'es'}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'list') {
    const leagueId = await requireLeagueId(interaction);
    if (!leagueId) return;

    const aliases = await listLeagueOcrNickAliases(leagueId);
    const lines = formatOcrNickAliasLines(aliases);
    await interaction.reply({
      content: ['**OCR nick aliases**', ...lines.map((line) => `• ${line}`)].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: 'Unknown OCR nick alias config subcommand.',
    flags: MessageFlags.Ephemeral,
  });
}
