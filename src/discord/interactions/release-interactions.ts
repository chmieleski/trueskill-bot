import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type {
  ButtonInteraction,
  Interaction,
  ModalSubmitInteraction,
  TextChannel,
} from 'discord.js';
import { prisma } from '../../lib/prisma.js';
import { assertCanConfigureBot } from '../../services/guild/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import {
  RELEASE_CUSTOM_PREFIX,
  buildPlayerReleaseEmbed,
  buildStaffReleaseButtons,
  buildStaffReleaseEmbed,
  parseReleaseCustomId,
  releaseModalCustomId,
} from '../../services/release/release-embed.js';
import { listPlayerChangelogChannels } from '../../services/release/release-config.js';
import {
  ALREADY_PUBLISHED,
  ALREADY_SKIPPED,
  assertCanPublish,
  dismissRelease,
  markReleasePublished,
  recordReleasePost,
  savePlayerNotes,
} from '../../services/release/release-publish.js';
import { ReleaseServiceError } from '../../services/release/errors.js';

const PLAYER_NOTES_FIELD = 'player_notes';
const PLAYER_NOTES_MAX = 4000;
const NOT_FOUND = 'That release was not found.';
const GUILD_ONLY = 'This action can only be used in a server.';

type ReleaseRow = {
  version: string;
  playerNotes: string;
  engineeringNotes: string;
  status: 'draft' | 'published' | 'skipped';
};

type StaffInteraction = ButtonInteraction | ModalSubmitInteraction;

/**
 * Handle changelog staff-card buttons and the player-notes modal.
 * Returns false when the interaction is not a changelog custom id.
 */
export async function handleReleaseInteraction(
  interaction: Interaction,
): Promise<boolean> {
  if (!interaction.isButton() && !interaction.isModalSubmit()) {
    return false;
  }
  if (!interaction.customId.startsWith(RELEASE_CUSTOM_PREFIX)) {
    return false;
  }

  const parsed = parseReleaseCustomId(interaction.customId);
  if (!parsed) {
    return true;
  }

  if (!interaction.guildId) {
    await replyEphemeral(interaction, GUILD_ONLY);
    return true;
  }

  try {
    assertCanConfigureBot({
      userId: interaction.user.id,
      memberPermissions: interaction.memberPermissions,
    });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await replyEphemeral(interaction, error.message);
      return true;
    }
    throw error;
  }

  if (parsed.action === 'modal') {
    if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction, parsed.version);
    }
    return true;
  }

  if (!interaction.isButton()) {
    return true;
  }

  try {
    if (parsed.action === 'edit') {
      await handleEdit(interaction, parsed.version);
    } else if (parsed.action === 'publish') {
      await handlePublish(interaction, parsed.version);
    } else if (parsed.action === 'dismiss') {
      await handleDismiss(interaction, parsed.version);
    }
  } catch (error) {
    if (error instanceof ReleaseServiceError || error instanceof MatchServiceError) {
      await replyEphemeral(interaction, error.message);
      return true;
    }
    throw error;
  }

  return true;
}

async function handleEdit(interaction: ButtonInteraction, version: string): Promise<void> {
  const release = await loadRelease(version);
  if (!release) {
    await replyEphemeral(interaction, NOT_FOUND);
    return;
  }

  assertReleaseIsDraft(release.status);

  const notes = release.playerNotes.slice(0, PLAYER_NOTES_MAX);
  const input = new TextInputBuilder()
    .setCustomId(PLAYER_NOTES_FIELD)
    .setLabel('Player notes')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(PLAYER_NOTES_MAX);
  if (notes.length > 0) {
    input.setValue(notes);
  }

  const modal = new ModalBuilder()
    .setCustomId(releaseModalCustomId(version))
    .setTitle(`Player notes · v${version}`)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

  await interaction.showModal(modal);
}

async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
  version: string,
): Promise<void> {
  const release = await loadRelease(version);
  if (!release) {
    await replyEphemeral(interaction, NOT_FOUND);
    return;
  }

  if (release.status !== 'draft') {
    await finishClosedModal(interaction, release);
    return;
  }

  const playerNotes = interaction.fields.getTextInputValue(PLAYER_NOTES_FIELD);
  await savePlayerNotes(version, playerNotes);
  const updated = (await loadRelease(version)) ?? {
    ...release,
    playerNotes: playerNotes.trim().slice(0, PLAYER_NOTES_MAX),
  };

  if (updated.status !== 'draft') {
    await finishClosedModal(interaction, updated);
    return;
  }

  const payload = {
    embeds: [
      buildStaffReleaseEmbed({
        version: updated.version,
        playerNotes: updated.playerNotes,
        engineeringNotes: updated.engineeringNotes,
        status: 'draft',
      }),
    ],
    components: buildStaffReleaseButtons(updated.version, 'draft'),
  };

  if (!interaction.isFromMessage()) {
    await replyEphemeral(interaction, 'That edit is no longer attached to a staff card.');
    return;
  }

  await interaction.update(payload);
}

/**
 * Restore the staff card to published/dismissed with no buttons. Skip when the
 * modal is no longer bound to that message.
 */
async function finishClosedModal(
  interaction: ModalSubmitInteraction,
  release: ReleaseRow,
): Promise<void> {
  if (!interaction.isFromMessage()) {
    await replyEphemeral(interaction, closedReleaseMessage(release.status));
    return;
  }

  await interaction.update({
    embeds: [
      buildStaffReleaseEmbed({
        version: release.version,
        playerNotes: release.playerNotes,
        engineeringNotes: release.engineeringNotes,
        status: release.status,
      }),
    ],
    components: [],
  });
}

function assertReleaseIsDraft(status: ReleaseRow['status']): void {
  if (status !== 'draft') {
    throw new ReleaseServiceError(closedReleaseMessage(status));
  }
}

function closedReleaseMessage(status: ReleaseRow['status']): string {
  return status === 'published' ? ALREADY_PUBLISHED : ALREADY_SKIPPED;
}

async function handlePublish(interaction: ButtonInteraction, version: string): Promise<void> {
  const release = await loadRelease(version);
  if (!release) {
    await replyEphemeral(interaction, NOT_FOUND);
    return;
  }

  assertCanPublish(release);
  await interaction.deferUpdate();

  const destinations = await listPlayerChangelogChannels();
  const failures: string[] = [];
  let publishedCount = 0;

  for (const dest of destinations) {
    const existing = await prisma.botReleasePost.findUnique({
      where: { version_guildId: { version, guildId: dest.guildId } },
      select: { version: true },
    });
    if (existing) {
      publishedCount += 1;
      continue;
    }

    try {
      const channel = await interaction.client.channels.fetch(dest.channelId);
      if (!channel || !channel.isTextBased()) {
        failures.push(formatPostFailure(dest.guildId, 'Unknown channel'));
        continue;
      }

      const message = await (channel as TextChannel).send({
        embeds: [
          buildPlayerReleaseEmbed({
            version: release.version,
            playerNotes: release.playerNotes,
          }),
        ],
      });

      await recordReleasePost({
        version,
        guildId: dest.guildId,
        channelId: dest.channelId,
        messageId: message.id,
      });
      publishedCount += 1;
    } catch (error) {
      failures.push(formatPostFailure(dest.guildId, postFailureReason(error)));
    }
  }

  await markReleasePublished(version);
  await interaction.editReply({
    embeds: [
      buildStaffReleaseEmbed({
        version: release.version,
        playerNotes: release.playerNotes,
        engineeringNotes: release.engineeringNotes,
        status: 'published',
        publishedCount,
        failures,
      }),
    ],
    components: [],
  });
}

async function handleDismiss(interaction: ButtonInteraction, version: string): Promise<void> {
  const release = await loadRelease(version);
  if (!release) {
    await replyEphemeral(interaction, NOT_FOUND);
    return;
  }

  await dismissRelease(version);
  await interaction.update({
    embeds: [
      buildStaffReleaseEmbed({
        version: release.version,
        playerNotes: release.playerNotes,
        engineeringNotes: release.engineeringNotes,
        status: 'skipped',
      }),
    ],
    components: [],
  });
}

async function loadRelease(version: string): Promise<ReleaseRow | null> {
  return prisma.botRelease.findUnique({
    where: { version },
    select: {
      version: true,
      playerNotes: true,
      engineeringNotes: true,
      status: true,
    },
  });
}

async function replyEphemeral(interaction: StaffInteraction, content: string): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

function formatPostFailure(guildId: string, reason: string): string {
  return `Could not post in guild \`${guildId}\`: ${reason}`;
}

function postFailureReason(error: unknown): string {
  const code = errorCode(error);
  if (code === 50001 || code === 50013) {
    return 'Missing access';
  }
  if (code === 10003) {
    return 'Unknown channel';
  }

  if (error instanceof Error) {
    if (/missing access/i.test(error.message)) {
      return 'Missing access';
    }
    if (/unknown channel/i.test(error.message)) {
      return 'Unknown channel';
    }
    return error.message;
  }

  return 'Unknown error';
}

function errorCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code: unknown };
    if (typeof code === 'number') {
      return code;
    }
  }
  return undefined;
}
