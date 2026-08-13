import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  addLobbyPlayer,
  cancelLobbyMatch,
  removeLobbyPlayer,
  startLobbyMatch,
  swapLobbyPlayers,
} from '../../services/lobby-actions.js';
import { MatchServiceError } from '../../services/match-service.js';

const log = createLogger('lobby_cmd');

const MIN_SLOT = 1;
const MAX_SLOT = 12;

export const data = new SlashCommandBuilder()
  .setName('lobby')
  .setDescription('Manage your pending match lobby')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('add')
      .setDescription('Add a player to your lobby')
      .addStringOption((option) =>
        option.setName('nick').setDescription('In-game nick').setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName('slot')
          .setDescription('Slot number (1-12)')
          .setRequired(true)
          .setMinValue(MIN_SLOT)
          .setMaxValue(MAX_SLOT),
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('Pending match id (required if you have more than one)')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('remove')
      .setDescription('Remove a player from your lobby by nick and/or slot')
      .addStringOption((option) =>
        option.setName('nick').setDescription('In-game nick').setRequired(false),
      )
      .addIntegerOption((option) =>
        option
          .setName('slot')
          .setDescription('Slot number (1-12)')
          .setRequired(false)
          .setMinValue(MIN_SLOT)
          .setMaxValue(MAX_SLOT),
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('Pending match id (required if you have more than one)')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('swap')
      .setDescription('Swap two players between occupied slots')
      .addIntegerOption((option) =>
        option
          .setName('slot_a')
          .setDescription('First occupied slot')
          .setRequired(true)
          .setMinValue(MIN_SLOT)
          .setMaxValue(MAX_SLOT),
      )
      .addIntegerOption((option) =>
        option
          .setName('slot_b')
          .setDescription('Second occupied slot')
          .setRequired(true)
          .setMinValue(MIN_SLOT)
          .setMaxValue(MAX_SLOT),
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('Pending match id (required if you have more than one)')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('cancel')
      .setDescription('Cancel your pending match lobby')
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('Pending match id (required if you have more than one)')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('start')
      .setDescription('Start your pending match')
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('Pending match id (required if you have more than one)')
          .setRequired(false),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const subcommand = interaction.options.getSubcommand(true);
  const matchId = interaction.options.getString('match_id');
  const hostDiscordId = interaction.user.id;

  log.info(
    { userId: hostDiscordId, subcommand, matchId, channelId: interaction.channelId },
    'Lobby command started',
  );

  try {
    if (subcommand === 'add') {
      const nick = interaction.options.getString('nick', true);
      const slot = interaction.options.getInteger('slot', true);
      const result = await addLobbyPlayer({
        client: interaction.client,
        hostDiscordId,
        matchId,
        nick,
        slot,
      });
      await interaction.editReply({
        content: `Added **${result.players.find((p) => p.slot === slot)?.nick ?? nick}** to slot ${slot} in match \`${result.match.id}\`.`,
      });
      return;
    }

    if (subcommand === 'remove') {
      const nick = interaction.options.getString('nick');
      const slot = interaction.options.getInteger('slot');
      const result = await removeLobbyPlayer({
        client: interaction.client,
        hostDiscordId,
        matchId,
        nick,
        slot,
      });
      await interaction.editReply({
        content: `Player removed from match \`${result.match.id}\`.`,
      });
      return;
    }

    if (subcommand === 'swap') {
      const slotA = interaction.options.getInteger('slot_a', true);
      const slotB = interaction.options.getInteger('slot_b', true);
      const result = await swapLobbyPlayers({
        client: interaction.client,
        hostDiscordId,
        matchId,
        slotA,
        slotB,
      });
      await interaction.editReply({
        content: `Swapped slots ${slotA} and ${slotB} in match \`${result.match.id}\`.`,
      });
      return;
    }

    if (subcommand === 'cancel') {
      const result = await cancelLobbyMatch({
        client: interaction.client,
        hostDiscordId,
        matchId,
      });
      await interaction.editReply({
        content: `Match \`${result.match.id}\` cancelled.`,
      });
      return;
    }

    if (subcommand === 'start') {
      const result = await startLobbyMatch({
        client: interaction.client,
        hostDiscordId,
        matchId,
      });
      await interaction.editReply({
        content: `Match \`${result.match.id}\` started.`,
      });
      return;
    }

    await interaction.editReply({ content: 'Unknown lobby subcommand.' });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      log.warn({ err: error, userId: hostDiscordId, subcommand }, 'Lobby command rejected');
      await interaction.editReply({ content: error.message });
      return;
    }

    log.error({ err: error, userId: hostDiscordId, subcommand }, 'Lobby command failed');
    await interaction.editReply({
      content: 'Could not update the lobby. Please try again.',
    });
  }
}
