import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import type { LobbyPlayer, ValidatedLobby } from './lobby-ocr.js';

export const LOBBY_CUSTOM_IDS = {
  confirm: 'lobby:confirm',
  fix: 'lobby:fix',
} as const;

export function formatTeamLines(players: LobbyPlayer[]): string {
  if (players.length === 0) {
    return '_Empty_';
  }

  return players.map((player) => `[Slot ${player.slot}] - ${player.nick}`).join('\n');
}

export function buildLobbyPreviewEmbed(lobby: ValidatedLobby): EmbedBuilder {
  const { teamA, teamB } = lobby;

  return new EmbedBuilder()
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
}

export function buildLobbyPreviewButtons(
  options: { disabled?: boolean } = {},
): ActionRowBuilder<ButtonBuilder> {
  const disabled = options.disabled ?? false;

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(LOBBY_CUSTOM_IDS.confirm)
      .setLabel('Confirm Teams')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(LOBBY_CUSTOM_IDS.fix)
      .setLabel('Fix Reading')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}
