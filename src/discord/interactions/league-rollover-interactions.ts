import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import {
  buildRolloverCancelCustomId,
  buildRolloverConfirmCustomId,
} from '../../services/league/index.js';

/** Build actor-bound Confirm/Cancel buttons for a league rollover preview. */
export function buildRolloverConfirmComponents(input: {
  draftId: string;
  actorDiscordId: string;
}): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(
          buildRolloverConfirmCustomId(input.draftId, input.actorDiscordId),
        )
        .setLabel('Confirm')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(
          buildRolloverCancelCustomId(input.draftId, input.actorDiscordId),
        )
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}
