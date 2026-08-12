import {
  ActionRowBuilder,
  Attachment,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import {
  extractLobbyPlayers,
  LobbyOcrError,
  validateLobbyPlayers,
  type LobbyPlayer,
} from '../../services/lobby-ocr.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function formatTeamLines(players: LobbyPlayer[]): string {
  return players.map((player) => `[Slot ${player.slot}] - ${player.nick}`).join('\n');
}

function isImageAttachment(attachment: Attachment): boolean {
  if (attachment.contentType?.startsWith('image/')) {
    return true;
  }

  const name = attachment.name?.toLowerCase() ?? '';
  const dotIndex = name.lastIndexOf('.');

  if (dotIndex === -1) {
    return false;
  }

  return IMAGE_EXTENSIONS.has(name.slice(dotIndex));
}

function resolveMimeType(attachment: Attachment): string {
  if (attachment.contentType?.startsWith('image/')) {
    return attachment.contentType.split(';')[0]!.trim();
  }

  const name = attachment.name?.toLowerCase() ?? '';

  if (name.endsWith('.png')) {
    return 'image/png';
  }

  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
    return 'image/jpeg';
  }

  if (name.endsWith('.webp')) {
    return 'image/webp';
  }

  if (name.endsWith('.gif')) {
    return 'image/gif';
  }

  return 'image/png';
}

export const data = new SlashCommandBuilder()
  .setName('register_lobby')
  .setDescription('Register a DBZ match lobby (up to 6v6) from a screenshot')
  .addAttachmentOption((option) =>
    option.setName('print').setDescription('Lobby screenshot').setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const attachment = interaction.options.getAttachment('print', true);

  if (!isImageAttachment(attachment)) {
    await interaction.editReply('Please attach a valid lobby screenshot image (PNG, JPG, WEBP, or GIF).');
    return;
  }

  try {
    const mimeType = resolveMimeType(attachment);
    const players = await extractLobbyPlayers(attachment.url, mimeType);
    const { teamA, teamB } = validateLobbyPlayers(players);

    // Slot X implies heroId X later — Hero table is not queried in this command.
    const embed = new EmbedBuilder()
      .setTitle('Lobby Preview')
      .setDescription('Review the OCR reading, then confirm or fix the teams.')
      .addFields(
        {
          name: `Team A (${teamA.length})`,
          value: formatTeamLines(teamA),
          inline: true,
        },
        {
          name: `Team B (${teamB.length})`,
          value: formatTeamLines(teamB),
          inline: true,
        },
      )
      .setColor(0x5865f2);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('confirm_lobby')
        .setLabel('Confirm Teams')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('edit_lobby')
        .setLabel('Fix Reading')
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction.editReply({
      embeds: [embed],
      components: [row],
    });
  } catch (error) {
    console.error('Failed to register lobby from screenshot:', error);

    const message =
      error instanceof LobbyOcrError
        ? error.message
        : 'Could not read the lobby screenshot. Please try again with a clearer image.';

    await interaction.editReply(message);
  }
}
