/** Per-seat lock: `slot` pins the player↔slot pair; `side` keeps the player on their team. */
export type LobbyLockMode = 'none' | 'slot' | 'side';

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

/**
 * Keep side lock only when the same playerId stays on the team it was side-locked on.
 * `previousSideLockedTeams` maps side-locked playerId → team before the rewrite.
 * `incomingSideLocked` follows the same false / undefined rules as
 * {@link reconcileMatchPlayerLocked}.
 */
export function reconcileMatchPlayerSideLocked(
  previousSideLockedTeams: ReadonlyMap<string, number>,
  playerId: string,
  team: number,
  incomingSideLocked: boolean | undefined,
): boolean {
  return incomingSideLocked !== false && previousSideLockedTeams.get(playerId) === team;
}

/** Lock mode stored on a seat (`locked` wins if both flags are somehow set). */
export function lockModeOf(seat: { locked?: boolean; sideLocked?: boolean }): LobbyLockMode {
  if (seat.locked === true) {
    return 'slot';
  }
  return seat.sideLocked === true ? 'side' : 'none';
}

/**
 * Next lock mode per occupied seat when `mode` should apply to exactly `wanted`:
 * selected seats take `mode`, unselected seats holding `mode` are cleared, and
 * seats holding the other lock mode keep it.
 */
export function lockChangesForSelection(
  players: Array<{ slot: number; locked?: boolean; sideLocked?: boolean }>,
  wanted: ReadonlySet<number>,
  mode: Exclude<LobbyLockMode, 'none'>,
): Array<{ slot: number; mode: LobbyLockMode }> {
  return players.map((player) => {
    if (wanted.has(player.slot)) {
      return { slot: player.slot, mode };
    }
    const current = lockModeOf(player);
    return { slot: player.slot, mode: current === mode ? 'none' : current };
  });
}
