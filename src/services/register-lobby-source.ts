import { MatchServiceError } from './match-service.js';

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
