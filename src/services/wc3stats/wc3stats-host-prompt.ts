import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { normalizeNick } from '../player/player-nick.js';
import { isWc3statsMap, type Wc3statsMapConfig } from './wc3stats-map.js';

export type HostPromptAction = 'open' | 'dismiss';

export type HostPromptCustomId = {
  action: HostPromptAction;
  leagueId: string;
  wc3statsId: number;
  hostDiscordId: string;
};

export type HostPromptListGame = {
  id: number;
  name: string;
  host: string;
  map: string;
};

export type HostPromptMatch = {
  wc3statsId: number;
  lobbyName: string;
  hostNick: string;
  hostDiscordId: string;
};

/**
 * Build a Discord button custom id for a host-lobby prompt action.
 */
export function buildHostPromptCustomId(input: HostPromptCustomId): string {
  return `host_prompt:${input.action}:${input.leagueId}:${input.wc3statsId}:${input.hostDiscordId}`;
}

/**
 * Parse a host-lobby prompt button custom id, or null when malformed.
 */
export function parseHostPromptCustomId(customId: string): HostPromptCustomId | null {
  const parts = customId.split(':');
  if (parts.length !== 5 || parts[0] !== 'host_prompt') {
    return null;
  }

  const action = parts[1];
  if (action !== 'open' && action !== 'dismiss') {
    return null;
  }

  const leagueId = parts[2] ?? '';
  const hostDiscordId = parts[4] ?? '';
  const wc3statsId = Number.parseInt(parts[3] ?? '', 10);

  if (!leagueId || !hostDiscordId || !Number.isInteger(wc3statsId) || wc3statsId <= 0) {
    return null;
  }

  return { action, leagueId, wc3statsId, hostDiscordId };
}

/**
 * Filter live gamelist rows to map-matching lobbies hosted by a linked Player.
 */
export function filterGamelistForHostPrompt(input: {
  games: HostPromptListGame[];
  mapConfig: Wc3statsMapConfig;
  /** Normalized nick → Discord user id for Players with discordId set. */
  linkedByNick: Map<string, string>;
}): HostPromptMatch[] {
  const matches: HostPromptMatch[] = [];

  for (const game of input.games) {
    if (!isWc3statsMap({ map: game.map }, input.mapConfig)) {
      continue;
    }

    const hostNick = normalizeNick(game.host);
    if (!hostNick) {
      continue;
    }

    const hostDiscordId = input.linkedByNick.get(hostNick);
    if (!hostDiscordId) {
      continue;
    }

    matches.push({
      wc3statsId: game.id,
      lobbyName: game.name.trim() || `Lobby ${game.id}`,
      hostNick,
      hostDiscordId,
    });
  }

  return matches;
}

/**
 * Public channel copy asking the linked host to open a Discord lobby.
 */
export function buildHostPromptMessageContent(input: {
  hostDiscordId: string;
  lobbyName: string;
  wc3statsId: number;
}): string {
  return (
    `<@${input.hostDiscordId}> — wc3stats found your lobby **${input.lobbyName}** (\`${input.wc3statsId}\`). ` +
    'Open a Discord match lobby from that Warcraft lobby?'
  );
}

/**
 * Ephemeral tip after the host dismisses (deletes) a prompt message.
 */
export function buildHostPromptDismissEphemeral(): string {
  return (
    'Prompt dismissed. To stop receiving these pings, run ' +
    '`/settings set host_prompt_pings enabled:False`.'
  );
}

/**
 * Open lobby / Dismiss buttons for a host prompt message.
 */
export function buildHostPromptButtons(input: {
  leagueId: string;
  wc3statsId: number;
  hostDiscordId: string;
}): ActionRowBuilder<ButtonBuilder>[] {
  const openId = buildHostPromptCustomId({
    action: 'open',
    leagueId: input.leagueId,
    wc3statsId: input.wc3statsId,
    hostDiscordId: input.hostDiscordId,
  });
  const dismissId = buildHostPromptCustomId({
    action: 'dismiss',
    leagueId: input.leagueId,
    wc3statsId: input.wc3statsId,
    hostDiscordId: input.hostDiscordId,
  });

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(openId).setLabel('Open lobby').setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(dismissId)
        .setLabel('Dismiss')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/** In-memory dedupe key for a prompted wc3stats lobby in a league. */
export function hostPromptDedupeKey(leagueId: string, wc3statsId: number): string {
  return `${leagueId}:${wc3statsId}`;
}
