/**
 * Soft lock pair key: same player identity in the same lobby slot.
 */
export function matchPlayerLockPairKey(playerId: string, slot: number): string {
  return `${playerId}:${slot}`;
}

/**
 * Keep soft lock only when the same playerId stays in the same slot and the
 * incoming lobby row still requests locked. OCR/wc3stats omit locked → false.
 */
export function reconcileMatchPlayerLocked(
  previousLockedPairs: ReadonlySet<string>,
  playerId: string,
  slot: number,
  incomingLocked: boolean,
): boolean {
  return incomingLocked && previousLockedPairs.has(matchPlayerLockPairKey(playerId, slot));
}
