import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  addLobbyPlayer,
  addLobbyPlayerFromDiscord,
  cancelLobbyMatch,
  refreshLobbyFromWc3stats,
  removeLobbyPlayer,
  resolveHostPendingMatch,
  startLobbyMatch,
  swapLobbyPlayers,
} from '../../services/lobby/index.js';
import { MatchServiceError } from '../../services/match/index.js';

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
      .addIntegerOption((option) =>
        option
          .setName('slot')
          .setDescription('Slot number (1-12)')
          .setRequired(true)
          .setMinValue(MIN_SLOT)
          .setMaxValue(MAX_SLOT),
      )
      .addStringOption((option) =>
        option.setName('nick').setDescription('In-game nick').setRequired(false),
      )
      .addUserOption((option) =>
        option
          .setName('user')
          .setDescription('Linked Discord member (instead of nick)')
          .setRequired(false),
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
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('sync')
      .setDescription('Attach or refresh the live Warcraft lobby from wc3stats')
      .addIntegerOption((option) =>
        option
          .setName('wc3stats_id')
          .setDescription('Game list id (optional if your linked nick is in the lobby)')
          .setRequired(false)
          .setMinValue(1),
      )
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
      const nickRaw = interaction.options.getString('nick')?.trim() || null;
      const user = interaction.options.getUser('user');
      const slot = interaction.options.getInteger('slot', true);

      if (nickRaw && user) {
        throw new MatchServiceError('Provide either a nick or a Discord user, not both.');
      }

      if (!nickRaw && !user) {
        throw new MatchServiceError('Provide a nick or a Discord user.');
      }

      const result = user
        ? await addLobbyPlayerFromDiscord({
            client: interaction.client,
            hostDiscordId,
            matchId,
            discordId: user.id,
            slot,
          })
        : await addLobbyPlayer({
            client: interaction.client,
            hostDiscordId,
            matchId,
            nick: nickRaw!,
            slot,
          });
      const seatedNick = result.players.find((player) => player.slot === slot)?.nick ?? nickRaw;
      await interaction.editReply({
        content: `Added **${seatedNick}** to slot ${slot} in match \`${result.match.id}\`.`,
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

    if (subcommand === 'sync') {
      const { match } = await resolveHostPendingMatch({ hostDiscordId, matchId });
      const result = await refreshLobbyFromWc3stats({
        client: interaction.client,
        actorDiscordId: hostDiscordId,
        memberRoleIds: [],
        matchId: match.id,
        wc3statsId: interaction.options.getInteger('wc3stats_id'),
        guildId: interaction.guildId,
      });
      await interaction.editReply({ content: result.message });
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
