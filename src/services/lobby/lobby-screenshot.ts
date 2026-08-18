import type { Attachment, Client } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { getGameProfileForLeague, LeagueNotFoundError } from '../league/league-profile.js';
import { MatchServiceError } from '../match/match-service.js';
import { applyRosterAndSync, type LobbyActionResult } from './discord-sync.js';
import { extractLobbyPlayers, type LobbyPlayer } from './lobby-ocr.js';
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
 */
export async function tryExtractLobbyPlayers(
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

async function profileForLeague(leagueId: string) {
  try {
    return await getGameProfileForLeague(leagueId);
  } catch (error) {
    if (error instanceof LeagueNotFoundError) {
      throw new MatchServiceError(error.message);
    }
    throw error;
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

  const profile = await profileForLeague(match.leagueId);
  assertRegisterLobbyAllowedForProfile(profile, {
    hasScreenshot: true,
    hasWc3statsId: false,
  });

  const extracted = await tryExtractLobbyPlayers(input.attachmentUrl, input.mimeType);

  if (extracted.length === 0) {
    log.info(
      { matchId: match.id, previousCount: current.length },
      'Screenshot OCR empty; kept existing roster',
    );
    return {
      match,
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

  return {
    ...result,
    keptExisting: false,
    message: LOBBY_UPDATED_MESSAGE,
  };
}
