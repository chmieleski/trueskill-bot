import { Events, MessageFlags } from 'discord.js';
import type { Interaction } from 'discord.js';
import { handleLeaderboardInteraction } from '../discord/interactions/leaderboard-interactions.js';
import { handleMatchHistoryInteraction } from '../discord/interactions/match-history-interactions.js';
import { handleHeroAllInteraction } from '../discord/interactions/hero-all-interactions.js';
import { handleHeroMatchesInteraction } from '../discord/interactions/hero-matches-interactions.js';
import { handleMatchListInteraction } from '../discord/interactions/match-list-interactions.js';
import { handleReleaseInteraction } from '../discord/interactions/release-interactions.js';
import { handleLobbyInteraction } from '../discord/interactions/lobby-interactions.js';
import { handleCaptainDraftInteraction } from '../discord/interactions/captain-draft-interactions.js';
import { handleHeroDraftInteraction } from '../discord/interactions/hero-draft-interactions.js';
import { handleMatchInteraction } from '../discord/interactions/match-interactions.js';
import { handleMatchApprovalInteraction } from '../discord/interactions/match-approval-interactions.js';
import { handleMatchCorrectionInteraction } from '../discord/interactions/match-correction-interactions.js';
import { handleLeagueRolloverInteraction } from '../discord/interactions/league-rollover-interactions.js';
import { handleRankResetInteraction } from '../discord/interactions/rank-reset-interactions.js';
import { handleNewPlayerInteraction } from '../discord/interactions/new-player-interactions.js';
import { handleWc3statsHostPromptInteraction } from '../discord/interactions/wc3stats-host-prompt-interactions.js';
import { createLogger } from '../lib/logger.js';
import { getLobbyChannelSlashDenial } from '../services/league/index.js';

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
    if (await handleMatchCorrectionInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'Match correction interaction handled');
      return;
    }

    if (await handleLeagueRolloverInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'League rollover interaction handled');
      return;
    }

    if (await handleRankResetInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'Rank reset interaction handled');
      return;
    }

    if (await handleNewPlayerInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'New-player interaction handled');
      return;
    }

    if (await handleWc3statsHostPromptInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'wc3stats host prompt interaction handled');
      return;
    }

    if (await handleMatchHistoryInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'Match history interaction handled');
      return;
    }

    if (await handleHeroMatchesInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'Hero matches interaction handled');
      return;
    }

    if (await handleHeroAllInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'Hero all interaction handled');
      return;
    }

    if (await handleMatchListInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'Match list interaction handled');
      return;
    }

    if (await handleLeaderboardInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'Leaderboard interaction handled');
      return;
    }

    if (await handleReleaseInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'Release interaction handled');
      return;
    }

    if (await handleMatchApprovalInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'Match approval interaction handled');
      return;
    }

    if (await handleMatchInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'Match interaction handled');
      return;
    }

    if (await handleCaptainDraftInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'Captain draft interaction handled');
      return;
    }

    if (await handleHeroDraftInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'Hero draft interaction handled');
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

  if (interaction.isAutocomplete()) {
    try {
      const denial = await getLobbyChannelSlashDenial(
        interaction.guildId,
        interaction.channelId,
        interaction.commandName,
        interaction.options.getSubcommand(false),
      );
      if (denial) {
        await interaction.respond([]);
        return;
      }

      const command = interaction.client.commands.get(interaction.commandName);
      if (command?.autocomplete) {
        await command.autocomplete(interaction);
      }
    } catch (error) {
      log.error(
        { err: error, command: interaction.commandName, userId: interaction.user.id },
        'Failed to handle autocomplete',
      );
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
    const denial = await getLobbyChannelSlashDenial(
      interaction.guildId,
      interaction.channelId,
      interaction.commandName,
      interaction.options.getSubcommand(false),
    );
    if (denial) {
      await interaction.reply({ content: denial, flags: MessageFlags.Ephemeral });
      return;
    }

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
