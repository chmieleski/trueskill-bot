import type { GameProfile } from '../../domain/game-profile.js';
import { getGameProfileForLeague } from '../league/league-profile.js';
import { MatchServiceError } from '../match/match-service.js';

export const SCREENSHOT_UNSUPPORTED_MESSAGE =
  'Lobby screenshots are not supported for this game yet.';
export const WC3STATS_UNSUPPORTED_MESSAGE =
  'Warcraft lobby import is not supported for this game.';
export const WC3STATS_CONFIG_UNSUPPORTED_MESSAGE =
  "This league's game does not use wc3stats import.";

/**
 * Games with `import: none` cannot start from a screenshot or wc3stats id.
 */
export function assertRegisterLobbyAllowedForProfile(
  profile: GameProfile,
  input: { hasScreenshot: boolean; hasWc3statsId: boolean },
): void {
  if (profile.import !== 'none') {
    return;
  }
  if (input.hasScreenshot) {
    throw new MatchServiceError(SCREENSHOT_UNSUPPORTED_MESSAGE);
  }
  if (input.hasWc3statsId) {
    throw new MatchServiceError(WC3STATS_UNSUPPORTED_MESSAGE);
  }
}

/** Reject wc3stats config/import when the league's game profile is not wc3stats. */
export async function assertLeagueAllowsWc3stats(leagueId: string): Promise<void> {
  const profile = await getGameProfileForLeague(leagueId);
  if (profile.import !== 'wc3stats') {
    throw new MatchServiceError(WC3STATS_CONFIG_UNSUPPORTED_MESSAGE);
  }
}

/**
 * Sync core for lobby import/sync/refresh: refuse games whose profile is not wc3stats.
 */
export function assertProfileAllowsWc3statsImport(profile: GameProfile): void {
  if (profile.import !== 'wc3stats') {
    throw new MatchServiceError(WC3STATS_UNSUPPORTED_MESSAGE);
  }
}

/** Reject wc3stats lobby import/sync/refresh when the league's game is not wc3stats. */
export async function assertLeagueAllowsWc3statsImport(leagueId: string): Promise<void> {
  const profile = await getGameProfileForLeague(leagueId);
  assertProfileAllowsWc3statsImport(profile);
}

export type RegisterLobbySource =
  | { kind: 'empty' }
  | { kind: 'screenshot'; url: string; mimeType: string }
  | { kind: 'wc3stats'; wc3statsId?: number };

export function parseWc3statsId(raw?: string | null): number | null {
  const value = raw?.trim() ?? '';
  if (value === '') {
    return null;
  }

  if (!/^\d+$/.test(value)) {
    throw new MatchServiceError('wc3stats_id must be a positive number.');
  }

  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new MatchServiceError('wc3stats_id must be a positive number.');
  }

  return id;
}

export type Wc3statsImportFailureCode =
  | 'not_found'
  | 'ambiguous'
  | 'not_udbr'
  | 'unavailable';

/**
 * Discord match creation does not require a live wc3stats lobby.
 * Misses stay empty; Refresh / /lobby sync can attach later.
 */
export function allowsEmptyMatchOnWc3statsFailure(code: Wc3statsImportFailureCode): boolean {
  switch (code) {
    case 'not_found':
    case 'ambiguous':
    case 'not_udbr':
    case 'unavailable':
      return true;
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

/**
 * Decide whether /register_lobby should OCR, import from wc3stats, or start empty.
 * Screenshot always wins for the roster. wc3stats_id may still be stored separately.
 */
export function resolveRegisterLobbySource(input: {
  attachmentUrl?: string | null;
  mimeType?: string | null;
  wc3statsEnabled?: boolean;
  wc3statsId?: number | null;
}): RegisterLobbySource {
  const url = input.attachmentUrl?.trim() ?? '';
  if (url !== '') {
    return {
      kind: 'screenshot',
      url,
      mimeType: input.mimeType?.trim() || 'image/png',
    };
  }

  if (input.wc3statsEnabled) {
    return {
      kind: 'wc3stats',
      wc3statsId: input.wc3statsId ?? undefined,
    };
  }

  return { kind: 'empty' };
}
