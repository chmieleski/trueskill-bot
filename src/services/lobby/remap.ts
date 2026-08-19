import { MatchServiceError } from '../match/match-service.js';

export type RemapPair = { raw: string; left: string; right: string };

function invalidPairMessage(segment: string): string {
  return `Invalid pair "${segment}". Use like 1-7 or Gohan-4.`;
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
