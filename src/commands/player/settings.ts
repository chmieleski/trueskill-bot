import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  getGameProfileForLeague,
  getLeagueOption,
  resolveLeagueIdFromInteraction,
  respondLeagueAutocomplete,
  withSubcommandLeagueOption,
} from '../../services/league/index.js';
import {
  getPlayerHostPromptPingsEnabled,
  PlayerServiceError,
  setPlayerHostPromptPingsEnabled,
} from '../../services/player/index.js';

const log = createLogger('settings_cmd');

function formatHostPromptPingsLine(enabled: boolean | null): string {
  if (enabled === null) {
    return '**wc3stats host lobby pings:** `n/a` (link your nick first)';
  }
  return `**wc3stats host lobby pings:** \`${enabled ? 'on' : 'off'}\``;
}

export const data = new SlashCommandBuilder()
  .setName('settings')
  .setDescription('View or change your personal bot settings')
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand.setName('view').setDescription('Show your personal bot settings'),
    ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('set')
      .setDescription('Change a personal setting')
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('host_prompt_pings')
            .setDescription('Allow pings when wc3stats finds your Warcraft lobby')
            .addBooleanOption((option) =>
              option
                .setName('enabled')
                .setDescription('On: ping me. Off: never ping me for host lobby prompts.')
                .setRequired(true),
            ),
        ),
      ),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondLeagueAutocomplete(interaction);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(true);

  try {
    if (!interaction.guildId) {
      await interaction.editReply({ content: 'This command can only be used in a server.' });
      return;
    }

    const resolved = await resolveLeagueIdFromInteraction(
      interaction,
      getLeagueOption(interaction),
    );
    if (!resolved.ok) {
      await interaction.editReply({ content: resolved.message });
      return;
    }

    const gameProfile = await getGameProfileForLeague(resolved.leagueId);

    if (subcommand === 'view') {
      const enabled = await getPlayerHostPromptPingsEnabled(
        gameProfile.gameId,
        interaction.user.id,
      );
      await interaction.editReply({
        content: [
          `Your personal bot settings for \`${gameProfile.gameId}\`:`,
          formatHostPromptPingsLine(enabled),
        ].join('\n'),
      });
      return;
    }

    if (subcommandGroup === 'set' && subcommand === 'host_prompt_pings') {
      const enabled = interaction.options.getBoolean('enabled', true);
      const updated = await setPlayerHostPromptPingsEnabled(
        gameProfile.gameId,
        interaction.user.id,
        enabled,
      );
      log.info(
        {
          userId: interaction.user.id,
          username: updated.username,
          gameId: gameProfile.gameId,
          enabled: updated.enabled,
        },
        'Host prompt ping preference updated',
      );
      await interaction.editReply({
        content: updated.enabled
          ? `Host lobby pings enabled for **${updated.username}** (\`${gameProfile.gameId}\`). You will be mentioned when wc3stats finds your matching lobby.`
          : `Host lobby pings disabled for **${updated.username}** (\`${gameProfile.gameId}\`). The bot will not ping you for wc3stats host lobby prompts.`,
      });
      return;
    }

    await interaction.editReply({ content: 'Unknown settings subcommand.' });
  } catch (error) {
    if (error instanceof PlayerServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    throw error;
  }
}
