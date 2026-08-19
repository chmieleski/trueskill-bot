import {
  invalidSlotMessage,
  isSlotInProfile,
  type GameProfile,
} from '../../domain/game-profile.js';
import { normalizeNick } from '../player/player-nick.js';
import { MatchServiceError } from '../match/match-service.js';
import type { LobbyPlayer } from './lobby-ocr.js';

export type RemapPair = { raw: string; left: string; right: string };

const SLOT_TOKEN = /^[1-9]\d*$/;

function invalidPairMessage(segment: string): string {
  return `Invalid pair "${segment}". Use like 1-7 or Gohan-4.`;
}

/**
 * Map a pair side to a slot. Digit tokens are slot attempts; everything else is a nick.
 */
export function resolveRemapSide(
  token: string,
  players: LobbyPlayer[],
  profile: GameProfile,
): number {
  const trimmed = token.trim();

  if (SLOT_TOKEN.test(trimmed)) {
    const slot = Number(trimmed);
    if (!isSlotInProfile(profile, slot)) {
      throw new MatchServiceError(invalidSlotMessage(profile));
    }
    return slot;
  }

  const nick = normalizeNick(trimmed);
  const player = players.find((entry) => entry.nick === nick);
  if (!player) {
    throw new MatchServiceError(`No player with nick "${nick}" in the lobby.`);
  }
  return player.slot;
}

/**
 * Split a host `pairs` string into left/right tokens.
 * Comma-separated only; each pair splits on the last ASCII hyphen.
 */
export function parseRemapPairs(raw: string): RemapPair[] {
  if (raw.trim() === '') {
    throw new MatchServiceError('pairs cannot be empty.');
  }

  const pairs: RemapPair[] = [];

  for (const segment of raw.split(',')) {
    const trimmed = segment.trim();
    if (trimmed === '') {
      throw new MatchServiceError(invalidPairMessage(''));
    }

    const dash = trimmed.lastIndexOf('-');
    if (dash <= 0 || dash === trimmed.length - 1) {
      throw new MatchServiceError(invalidPairMessage(trimmed));
    }

    const left = trimmed.slice(0, dash).trim();
    const right = trimmed.slice(dash + 1).trim();
    if (left === '' || right === '') {
      throw new MatchServiceError(invalidPairMessage(trimmed));
    }

    pairs.push({ raw: trimmed, left, right });
  }

  return pairs;
}
