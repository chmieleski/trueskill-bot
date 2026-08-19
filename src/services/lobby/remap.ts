import {
  invalidSlotMessage,
  isSlotInProfile,
  type GameProfile,
} from '../../domain/game-profile.js';
import { normalizeNick } from '../player/player-nick.js';
import { MatchServiceError } from '../match/match-service.js';
import type { LobbyPlayer } from './lobby-ocr.js';
import { movePlayer } from './roster.js';

export type RemapPair = { raw: string; left: string; right: string };

export type SwapForm =
  | { kind: 'classic'; slotA: number; slotB: number }
  | { kind: 'pairs'; pairs: string };

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

/**
 * Apply every pair left to right on a working roster. Does not persist.
 * Parse errors keep their own copy; resolve/move errors are prefixed with the pair.
 */
export function applyRemapPairs(
  players: LobbyPlayer[],
  raw: string,
  profile: GameProfile,
): LobbyPlayer[] {
  const pairs = parseRemapPairs(raw);
  let working = players;

  for (const pair of pairs) {
    try {
      const fromSlot = resolveRemapSide(pair.left, working, profile);
      const toSlot = resolveRemapSide(pair.right, working, profile);
      working = movePlayer(working, fromSlot, toSlot, profile);
    } catch (error) {
      if (error instanceof MatchServiceError) {
        throw new MatchServiceError(`Could not apply ${pair.raw}: ${error.message}`);
      }
      throw error;
    }
  }

  return working;
}

/**
 * Discord `/lobby swap` XOR: classic two slots, or a pairs string, never both.
 * Whitespace-only `pairs` counts as absent.
 */
export function resolveSwapForm(input: {
  slotA: number | null;
  slotB: number | null;
  pairs: string | null;
}): SwapForm {
  const pairs = input.pairs?.trim() ?? '';
  const hasPairs = pairs !== '';
  const hasA = input.slotA !== null;
  const hasB = input.slotB !== null;

  if (hasPairs && !hasA && !hasB) {
    return { kind: 'pairs', pairs };
  }

  if (!hasPairs && hasA && hasB) {
    return { kind: 'classic', slotA: input.slotA!, slotB: input.slotB! };
  }

  if (hasPairs && (hasA || hasB)) {
    throw new MatchServiceError(
      'Use either slot_a and slot_b, or pairs, not both.',
    );
  }

  if (hasA !== hasB) {
    throw new MatchServiceError(
      'Provide both slot_a and slot_b, or use pairs instead.',
    );
  }

  throw new MatchServiceError('Provide slot_a and slot_b, or pairs.');
}
