import type { Attachment, Client } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { touchLobbyRosterAuthority } from '../match/match-service.js';
import { getGameProfileForMatch } from '../match/match-service.js';
import {
  applyRosterAndSync,
  syncLobbyDiscordMessage,
  withNewPlayerSuggestions,
  type LobbyActionResult,
} from './discord-sync.js';
import { extractLobbyPlayers, type LobbyPlayer } from './lobby-ocr.js';
import { applyOcrNickAliases, loadLeagueOcrNickAliasMap } from './ocr-nick-aliases.js';
import { assertRegisterLobbyAllowedForProfile } from './register-lobby-source.js';
import { resolvePendingMatchForManage } from './resolve.js';

const log = createLogger('lobby-screenshot');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

const OCR_EMPTY_MESSAGE =
  'Could not read any players from the screenshot. Your current roster was kept.';
const LOBBY_UPDATED_MESSAGE = 'Lobby updated from screenshot.';

export interface RefreshLobbyScreenshotResult extends LobbyActionResult {
  keptExisting: boolean;
  message: string;
}

/** True when the Discord attachment looks like an image file. */
export function isImageAttachment(attachment: Attachment): boolean {
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

/** Resolve a MIME type for Gemini OCR from a Discord attachment. */
export function resolveMimeType(attachment: Attachment): string {
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
 * Partial lobbies are kept even when both-teams validation would fail.
 * When `leagueId` is set, apply that league's OCR nick aliases after extract.
 */
export async function tryExtractLobbyPlayers(
  url: string,
  mimeType: string,
  leagueId?: string | null,
): Promise<LobbyPlayer[]> {
  try {
    const players = await extractLobbyPlayers(url, mimeType);
    if (leagueId && players.length > 0) {
      const aliasMap = await loadLeagueOcrNickAliasMap(leagueId);
      const aliased = applyOcrNickAliases(players, aliasMap);
      log.debug(
        { playerCount: aliased.length, players: aliased, leagueId },
        'OCR players extracted (aliases applied)',
      );
      return aliased;
    }
    log.debug({ playerCount: players.length, players }, 'OCR players extracted');
    return players;
  } catch (error) {
    log.warn({ err: error }, 'OCR failed; continuing with empty lobby');
    return [];
  }
}

/**
 * Host or match moderator replaces a PENDING lobby roster from a Warcraft lobby screenshot.
 * When OCR finds no players, the current roster is kept.
 */
export async function refreshLobbyFromScreenshot(input: {
  client: Client;
  actorDiscordId: string;
  memberRoleIds: string[];
  matchModRoleId?: string;
  matchId?: string | null;
  attachmentUrl: string;
  mimeType: string;
}): Promise<RefreshLobbyScreenshotResult> {
  const { match, players: current } = await resolvePendingMatchForManage({
    actorDiscordId: input.actorDiscordId,
    matchId: input.matchId,
    memberRoleIds: input.memberRoleIds,
    matchModRoleId: input.matchModRoleId,
  });

  const profile = await getGameProfileForMatch(match);
  assertRegisterLobbyAllowedForProfile(profile, {
    hasScreenshot: true,
    hasWc3statsId: false,
  });

  const extracted = await tryExtractLobbyPlayers(
    input.attachmentUrl,
    input.mimeType,
    match.leagueId,
  );

  if (extracted.length === 0) {
    const touched = await touchLobbyRosterAuthority(match.id);
    await syncLobbyDiscordMessage(input.client, touched, 'pending');
    log.info(
      { matchId: match.id, previousCount: current.length },
      'Screenshot OCR empty; kept existing roster and marked authority',
    );
    return {
      match: touched,
      players: current,
      keptExisting: true,
      message: OCR_EMPTY_MESSAGE,
    };
  }

  const result = await applyRosterAndSync(input.client, match.id, extracted);
  log.info(
    { matchId: match.id, previousCount: current.length, playerCount: extracted.length },
    'Lobby roster replaced from screenshot',
  );

  const withSuggestions = await withNewPlayerSuggestions(
    result,
    new Set(match.players.map((player) => player.playerId)),
  );

  return {
    ...withSuggestions,
    keptExisting: false,
    message: LOBBY_UPDATED_MESSAGE,
  };
}
