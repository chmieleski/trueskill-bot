import {
  MessageFlags,
  type ActionRowBuilder,
  type ButtonBuilder,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuBuilder,
} from 'discord.js';
import { deletePreviousEphemeral, rememberEphemeral } from './ephemeral-session.js';

type ComponentRow =
  | ActionRowBuilder<ButtonBuilder>
  | ActionRowBuilder<StringSelectMenuBuilder>;

type EphemeralPayload = {
  content: string;
  components?: ComponentRow[];
};

/**
 * Modal deferReply → edit the same ephemeral (no stack).
 * Otherwise delete previous private UI for this user+channel, then reply/followUp and remember.
 */
export async function sendReplacingEphemeral(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  payload: EphemeralPayload,
): Promise<void> {
  const components = payload.components ?? [];
  const channelId = interaction.channelId;

  if (interaction.deferred || interaction.replied) {
    if (interaction.isModalSubmit()) {
      await interaction.editReply({
        content: payload.content,
        components,
      });
      if (channelId) {
        rememberEphemeral(interaction.user.id, channelId, {
          applicationId: interaction.applicationId,
          token: interaction.token,
          messageId: '@original',
        });
      }
      return;
    }

    if (channelId) {
      await deletePreviousEphemeral(
        interaction.client,
        interaction.user.id,
        channelId,
      );
    }

    const message = await interaction.followUp({
      content: payload.content,
      components,
      flags: MessageFlags.Ephemeral,
    });

    if (channelId) {
      rememberEphemeral(interaction.user.id, channelId, {
        applicationId: interaction.applicationId,
        token: interaction.token,
        messageId: message.id,
      });
    }
    return;
  }

  if (channelId) {
    await deletePreviousEphemeral(
      interaction.client,
      interaction.user.id,
      channelId,
    );
  }

  await interaction.reply({
    content: payload.content,
    components,
    flags: MessageFlags.Ephemeral,
  });

  if (channelId) {
    rememberEphemeral(interaction.user.id, channelId, {
      applicationId: interaction.applicationId,
      token: interaction.token,
      messageId: '@original',
    });
  }
}

/**
 * After interaction.update / editReply on an existing ephemeral wizard step,
 * refresh the stored token so a later replace can still delete this message.
 */
export function touchEphemeralSession(
  interaction: MessageComponentInteraction,
): void {
  const channelId = interaction.channelId;
  if (!channelId) {
    return;
  }

  rememberEphemeral(interaction.user.id, channelId, {
    applicationId: interaction.applicationId,
    token: interaction.token,
    messageId: interaction.message.id,
  });
}
