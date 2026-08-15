import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
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
    subcommand.setName('view').setDescription('Show your personal bot settings'),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('set')
      .setDescription('Change a personal setting')
      .addSubcommand((subcommand) =>
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
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(true);

  try {
    if (subcommand === 'view') {
      const enabled = await getPlayerHostPromptPingsEnabled(interaction.user.id);
      await interaction.editReply({
        content: ['Your personal bot settings:', formatHostPromptPingsLine(enabled)].join(
          '\n',
        ),
      });
      return;
    }

    if (subcommandGroup === 'set' && subcommand === 'host_prompt_pings') {
      const enabled = interaction.options.getBoolean('enabled', true);
      const updated = await setPlayerHostPromptPingsEnabled(interaction.user.id, enabled);
      log.info(
        { userId: interaction.user.id, username: updated.username, enabled: updated.enabled },
        'Host prompt ping preference updated',
      );
      await interaction.editReply({
        content: updated.enabled
          ? `Host lobby pings enabled for **${updated.username}**. You will be mentioned when wc3stats finds your matching lobby.`
          : `Host lobby pings disabled for **${updated.username}**. The bot will not ping you for wc3stats host lobby prompts.`,
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
