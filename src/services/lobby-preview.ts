import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import type { LobbyPlayer, ValidatedLobby } from './lobby-ocr.js';
import { validateLobbyPlayers } from './lobby-ocr.js';

export const LOBBY_CUSTOM_IDS = {
  start: 'lobby:start',
  fix: 'lobby:fix',
} as const;

export function formatTeamLines(players: LobbyPlayer[]): string {
  if (players.length === 0) {
    return '_Empty_';
  }

  return players.map((player) => `[Slot ${player.slot}] - ${player.nick}`).join('\n');
}

export function splitLobbyPlayers(players: LobbyPlayer[]): ValidatedLobby {
  const teamA = players
    .filter((player) => player.slot <= 6)
    .sort((a, b) => a.slot - b.slot);
  const teamB = players
    .filter((player) => player.slot > 6)
    .sort((a, b) => a.slot - b.slot);

  return { teamA, teamB };
}

export function canStartLobby(players: LobbyPlayer[]): boolean {
  try {
    validateLobbyPlayers(players);
    return true;
  } catch {
    return false;
  }
}

export function buildMatchLobbyEmbed(
  matchId: string,
  players: LobbyPlayer[],
  options: { canStart?: boolean } = {},
): EmbedBuilder {
  const { teamA, teamB } = splitLobbyPlayers(players);
  const canStart = options.canStart ?? canStartLobby(players);

  const description = canStart
    ? `Match \`${matchId}\`\nReview the lobby, then start when ready.`
    : `Match \`${matchId}\`\nAdd at least one human player to each team before starting.`;

  return new EmbedBuilder()
    .setTitle('Match Lobby')
    .setDescription(description)
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

export function buildMatchInProgressEmbed(
  matchId: string,
  players: LobbyPlayer[],
): EmbedBuilder {
  const { teamA, teamB } = splitLobbyPlayers(players);

  return new EmbedBuilder()
    .setTitle('Match In Progress')
    .setDescription(`Match \`${matchId}\` has started.`)
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
    .setColor(0x57f287);
}

export function buildMatchCancelledEmbed(
  matchId: string,
  reason: string = 'expired',
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('Match Cancelled')
    .setDescription(`Match \`${matchId}\` was cancelled (${reason}).`)
    .setColor(0xed4245);
}

export function buildLobbyButtons(
  options: { canStart?: boolean; locked?: boolean } = {},
): ActionRowBuilder<ButtonBuilder>[] {
  if (options.locked) {
    return [];
  }

  const canStart = options.canStart ?? false;
  const row = new ActionRowBuilder<ButtonBuilder>();

  if (canStart) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(LOBBY_CUSTOM_IDS.start)
        .setLabel('Start Match')
        .setStyle(ButtonStyle.Success),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(LOBBY_CUSTOM_IDS.fix)
      .setLabel('Fix Reading')
      .setStyle(ButtonStyle.Secondary),
  );

  return [row];
}
