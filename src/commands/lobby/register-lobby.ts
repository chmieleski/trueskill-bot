import { Attachment, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { extractLobbyPlayers, type LobbyPlayer } from '../../services/lobby-ocr.js';
import {
  buildLobbyButtons,
  buildMatchLobbyEmbed,
  canStartLobby,
} from '../../services/lobby-preview.js';
import {
  attachDiscordMessage,
  createPendingMatch,
  getMatchById,
  MatchServiceError,
} from '../../services/match-service.js';
import {
  loadLobbyRatingPreview,
  matchPlayersToRatingEntries,
} from '../../services/rating-preview.js';

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

/**
 * Soft OCR: return extracted players when possible, otherwise [].
 * Keep partial lobbies even when both-teams validation fails.
 */
async function tryExtractLobbyPlayers(
  url: string,
  mimeType: string,
): Promise<LobbyPlayer[]> {
  try {
    const players = await extractLobbyPlayers(url, mimeType);
    log.debug({ playerCount: players.length, players }, 'OCR players extracted');
    return players;
  } catch (error) {
    log.warn({ err: error }, 'OCR failed; continuing with empty lobby');
    return [];
  }
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
      channelId: interaction.channelId,
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

  if (!interaction.channelId) {
    await interaction.editReply('Could not determine the channel for this lobby.');
    return;
  }

  const mimeType = resolveMimeType(attachment);
  const players = await tryExtractLobbyPlayers(attachment.url, mimeType);
  const canStart = canStartLobby(players);

  try {
    const created = await createPendingMatch({
      hostDiscordId: interaction.user.id,
      discordChannelId: interaction.channelId,
      players,
    });

    const match = await getMatchById(created.matchId);
    const ratingPreview = match
      ? await loadLobbyRatingPreview(matchPlayersToRatingEntries(match.players))
      : undefined;

    await interaction.editReply({
      embeds: [
        buildMatchLobbyEmbed(created.matchId, players, {
          canStart,
          createdAt: created.createdAt,
          ratingPreview,
        }),
      ],
      components: buildLobbyButtons({ canStart }),
    });

    const previewMessage = await interaction.fetchReply();

    await attachDiscordMessage(created.matchId, previewMessage.id, interaction.channelId);

    log.info(
      {
        matchId: created.matchId,
        messageId: previewMessage.id,
        ownerId: interaction.user.id,
        playerCount: players.length,
        canStart,
      },
      'Match lobby registered',
    );
  } catch (error) {
    if (error instanceof MatchServiceError) {
      log.warn({ err: error, userId: interaction.user.id }, 'Match lobby registration rejected');
      await interaction.editReply(error.message);
      return;
    }

    log.error({ err: error, userId: interaction.user.id }, 'Failed to register match lobby');
    await interaction.editReply('Could not create the match lobby. Please try again.');
  }
}
