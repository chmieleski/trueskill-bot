import { Attachment, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { setLobbyDraft } from '../../services/lobby-draft-store.js';
import {
  extractLobbyPlayers,
  LobbyOcrError,
  validateLobbyPlayers,
} from '../../services/lobby-ocr.js';
import {
  buildLobbyPreviewButtons,
  buildLobbyPreviewEmbed,
} from '../../services/lobby-preview.js';

const log = createLogger('register_lobby');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

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

  log.info(
    {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      attachmentName: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
    },
    'Register lobby started',
  );

  if (!isImageAttachment(attachment)) {
    log.warn(
      { userId: interaction.user.id, contentType: attachment.contentType, name: attachment.name },
      'Rejected non-image attachment',
    );
    await interaction.editReply('Please attach a valid lobby screenshot image (PNG, JPG, WEBP, or GIF).');
    return;
  }

  try {
    const mimeType = resolveMimeType(attachment);
    log.debug({ mimeType }, 'Resolved attachment MIME type');

    const players = await extractLobbyPlayers(attachment.url, mimeType);
    log.debug({ playerCount: players.length, players }, 'OCR players extracted');

    const validated = validateLobbyPlayers(players);
    log.info(
      {
        teamA: validated.teamA.length,
        teamB: validated.teamB.length,
        slots: [...validated.teamA, ...validated.teamB].map((player) => player.slot),
      },
      'Lobby players validated',
    );

    // Slot X implies heroId X later — Hero table is not queried in this command.
    await interaction.editReply({
      embeds: [buildLobbyPreviewEmbed(validated)],
      components: [buildLobbyPreviewButtons()],
    });

    const previewMessage = await interaction.fetchReply();
    const flatPlayers = [...validated.teamA, ...validated.teamB];

    setLobbyDraft(previewMessage.id, {
      ownerId: interaction.user.id,
      players: flatPlayers,
    });

    log.info(
      { messageId: previewMessage.id, ownerId: interaction.user.id, playerCount: flatPlayers.length },
      'Lobby draft created',
    );
  } catch (error) {
    if (error instanceof LobbyOcrError) {
      log.warn({ err: error, userId: interaction.user.id }, 'Lobby registration rejected');
    } else {
      log.error({ err: error, userId: interaction.user.id }, 'Failed to register lobby from screenshot');
    }

    const message =
      error instanceof LobbyOcrError
        ? error.message
        : 'Could not read the lobby screenshot. Please try again with a clearer image.';

    await interaction.editReply(message);
  }
}
