import { prisma } from '../../lib/prisma.js';
import { MatchServiceError } from '../match/match-service.js';

export const LOBBY_CHANNEL_ENABLE_NEEDS_CHANNEL =
  'Choose a channel when enabling the lobby channel.';
export const LOBBY_CHANNEL_CHANNEL_ONLY_WHILE_DISABLED =
  'Pass enabled:true to turn the lobby channel on.';
export const LOBBY_CHANNEL_HOST_PROMPT_MISMATCH =
  'The wc3stats host prompt channel must match the lobby channel while the lobby channel is enabled.';
export const LOBBY_CHANNEL_SET_NEEDS_OPTION = 'Provide enabled and/or channel.';

/** User-facing copy when /register_lobby or Open lobby is used outside the gated channel. */
export function lobbyCreationLimitedMessage(channelId: string): string {
  return `Lobby creation for this league is limited to <#${channelId}>.`;
}

function trimOptionalId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** True when the league gate is on and a channel id is stored. */
export function isLeagueLobbyChannelReady(config: {
  lobbyChannelEnabled?: boolean | null;
  lobbyChannelId?: string | null;
}): boolean {
  return config.lobbyChannelEnabled === true && Boolean(trimOptionalId(config.lobbyChannelId));
}

/**
 * Throw if lobby creation is gated to another Discord channel.
 * No-op when the league gate is not ready.
 */
export function assertLobbyCreateChannel(
  config: {
    lobbyChannelEnabled?: boolean | null;
    lobbyChannelId?: string | null;
  },
  channelId: string,
): void {
  if (!isLeagueLobbyChannelReady(config)) {
    return;
  }
  const lobbyChannelId = trimOptionalId(config.lobbyChannelId)!;
  if (channelId !== lobbyChannelId) {
    throw new MatchServiceError(lobbyCreationLimitedMessage(lobbyChannelId));
  }
}

/**
 * Throw if the next lobby-channel state and a configured host-prompt channel would differ.
 */
export function assertLobbyHostPromptChannelsCompatible(input: {
  lobbyEnabled: boolean;
  lobbyChannelId: string | undefined;
  hostPromptEnabled: boolean;
  hostPromptChannelId: string | undefined;
}): void {
  const lobbyReady = input.lobbyEnabled && Boolean(input.lobbyChannelId);
  const promptConfigured = input.hostPromptEnabled && Boolean(input.hostPromptChannelId);
  if (!lobbyReady || !promptConfigured) {
    return;
  }
  if (input.lobbyChannelId !== input.hostPromptChannelId) {
    throw new MatchServiceError(LOBBY_CHANNEL_HOST_PROMPT_MISMATCH);
  }
}

/** Load league lobby-channel fields and assert the interaction channel. */
export async function assertLeagueLobbyCreateChannel(
  leagueId: string,
  channelId: string,
): Promise<void> {
  const row = await prisma.league.findUnique({
    where: { id: leagueId },
    select: { lobbyChannelEnabled: true, lobbyChannelId: true },
  });
  assertLobbyCreateChannel(row ?? {}, channelId);
}

/**
 * Set or toggle the per-league lobby creation channel.
 * `enabled: false` keeps `lobbyChannelId`. Channel-only updates require the gate already on.
 */
export async function setLeagueLobbyChannel(
  leagueId: string,
  input: { enabled?: boolean; channelId?: string },
): Promise<void> {
  if (input.enabled === undefined && input.channelId === undefined) {
    throw new MatchServiceError(LOBBY_CHANNEL_SET_NEEDS_OPTION);
  }

  const row = await prisma.league.findUnique({
    where: { id: leagueId },
    select: {
      lobbyChannelEnabled: true,
      lobbyChannelId: true,
      wc3statsHostPromptEnabled: true,
      wc3statsHostPromptChannelId: true,
    },
  });

  const storedId = trimOptionalId(row?.lobbyChannelId);
  const currentlyEnabled = row?.lobbyChannelEnabled === true;
  const hostPromptEnabled = row?.wc3statsHostPromptEnabled === true;
  const hostPromptChannelId = trimOptionalId(row?.wc3statsHostPromptChannelId);

  if (input.enabled === false) {
    await prisma.league.update({
      where: { id: leagueId },
      data: { lobbyChannelEnabled: false },
    });
    return;
  }

  if (input.enabled === undefined) {
    const nextId = trimOptionalId(input.channelId);
    if (!currentlyEnabled || !storedId || !nextId) {
      throw new MatchServiceError(LOBBY_CHANNEL_CHANNEL_ONLY_WHILE_DISABLED);
    }
    assertLobbyHostPromptChannelsCompatible({
      lobbyEnabled: true,
      lobbyChannelId: nextId,
      hostPromptEnabled,
      hostPromptChannelId,
    });
    await prisma.league.update({
      where: { id: leagueId },
      data: { lobbyChannelId: nextId },
    });
    return;
  }

  const nextId = trimOptionalId(input.channelId) ?? storedId;
  if (!nextId) {
    throw new MatchServiceError(LOBBY_CHANNEL_ENABLE_NEEDS_CHANNEL);
  }
  assertLobbyHostPromptChannelsCompatible({
    lobbyEnabled: true,
    lobbyChannelId: nextId,
    hostPromptEnabled,
    hostPromptChannelId,
  });
  await prisma.league.update({
    where: { id: leagueId },
    data: { lobbyChannelEnabled: true, lobbyChannelId: nextId },
  });
}

/** Disable the gate and forget the stored channel. */
export async function clearLeagueLobbyChannel(leagueId: string): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { lobbyChannelEnabled: false, lobbyChannelId: null },
  });
}

/** `/config view` line. Invalid enabled-without-id is shown as off. */
export function formatLobbyChannelConfigLine(
  enabled: boolean,
  channelId: string | undefined,
): string {
  if (!channelId) {
    return '**Lobby channel:** `off`';
  }
  if (!enabled) {
    return `**Lobby channel:** \`off\` · saved <#${channelId}>`;
  }
  return `**Lobby channel:** \`on\` · <#${channelId}>`;
}

const LOBBY_CHANNEL_ALLOWED_MATCH_SUBCOMMANDS = new Set([
  'complete',
  'cancel',
  'quitters',
  'griefers',
]);

/** User-facing copy when a non-allowlisted slash command is used in a ready lobby channel. */
export function lobbyChannelCommandsLimitedMessage(channelId: string): string {
  return `Only lobby and match commands can be used in <#${channelId}>.`;
}

/**
 * Slash commands permitted inside a ready league lobby channel.
 * `/match` is limited to in-progress ops; missing/unknown subcommand is denied.
 */
export function isLobbyChannelAllowedCommand(
  commandName: string,
  subcommand?: string | null,
): boolean {
  if (commandName === 'register_lobby' || commandName === 'lobby') {
    return true;
  }
  if (commandName === 'match') {
    return (
      typeof subcommand === 'string' && LOBBY_CHANNEL_ALLOWED_MATCH_SUBCOMMANDS.has(subcommand)
    );
  }
  return false;
}

/**
 * True when any league in the guild has the lobby channel gate ready on this channel id.
 * Stored ids are trimmed on write; query uses the interaction channel id as-is.
 */
export async function isGuildLobbyChannel(guildId: string, channelId: string): Promise<boolean> {
  const row = await prisma.league.findFirst({
    where: {
      guildId,
      lobbyChannelEnabled: true,
      lobbyChannelId: channelId,
    },
    select: { id: true },
  });
  return row != null;
}

/**
 * If this slash/autocomplete must be blocked in the current channel, return the deny message.
 * Otherwise null (proceed). Allowed commands skip the DB lookup.
 */
export async function getLobbyChannelSlashDenial(
  guildId: string | null,
  channelId: string | null,
  commandName: string,
  subcommand?: string | null,
): Promise<string | null> {
  if (!guildId || !channelId) {
    return null;
  }
  if (isLobbyChannelAllowedCommand(commandName, subcommand)) {
    return null;
  }
  if (!(await isGuildLobbyChannel(guildId, channelId))) {
    return null;
  }
  return lobbyChannelCommandsLimitedMessage(channelId);
}
