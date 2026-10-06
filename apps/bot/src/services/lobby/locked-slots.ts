/**
 * Soft lock pair key: same player identity in the same lobby slot.
 */
export function matchPlayerLockPairKey(playerId: string, slot: number): string {
  return `${playerId}:${slot}`;
}

/**
 * Keep soft lock only when the same playerId stays in the same slot.
 * `incomingLocked` false = explicit unlock; undefined = no opinion (screenshot /
 * wc3stats reads), so a player still in their locked seat stays locked.
 */
export function reconcileMatchPlayerLocked(
  previousLockedPairs: ReadonlySet<string>,
  playerId: string,
  slot: number,
  incomingLocked: boolean | undefined,
): boolean {
  return (
    incomingLocked !== false && previousLockedPairs.has(matchPlayerLockPairKey(playerId, slot))
  );
}
