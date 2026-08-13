import { Events, MessageFlags } from 'discord.js';
import type { Interaction } from 'discord.js';
import { handleLobbyInteraction } from '../handlers/lobby-interactions.js';
import { handleMatchInteraction } from '../handlers/match-interactions.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('interaction');

export const name = Events.InteractionCreate;

export async function execute(interaction: Interaction): Promise<void> {
  log.verbose(
    {
      type: interaction.type,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
    },
    'Interaction received',
  );

  try {
    if (await handleMatchInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'Match interaction handled');
      return;
    }

    if (await handleLobbyInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'Lobby interaction handled');
      return;
    }
  } catch (error) {
    log.error(
      {
        err: error,
        userId: interaction.user.id,
        customId:
          interaction.isMessageComponent() || interaction.isModalSubmit()
            ? interaction.customId
            : undefined,
      },
      'Failed to handle message component interaction',
    );

    const content = 'An error occurred while processing this action.';

    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }

    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = interaction.client.commands.get(interaction.commandName);

  if (!command) {
    log.error({ commandName: interaction.commandName }, 'Command not found');
    return;
  }

  log.info(
    {
      command: interaction.commandName,
      userId: interaction.user.id,
      guildId: interaction.guildId,
    },
    'Executing slash command',
  );

  try {
    await command.execute(interaction);
    log.debug({ command: interaction.commandName }, 'Slash command finished');
  } catch (error) {
    log.error(
      { err: error, command: interaction.commandName, userId: interaction.user.id },
      'Failed to execute slash command',
    );

    const content = 'An error occurred while processing this command.';

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}
