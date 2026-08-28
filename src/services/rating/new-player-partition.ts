/** Stable seat key for pair-off (team + slot). */
export function entryPairKey(entry: { team: 1 | 2; slot: number }): string {
  return `${entry.team}:${entry.slot}`;
}

export type NewPlayerPartitionEntry = {
  team: 1 | 2;
  slot: number;
  /** Rating apply + completed-match balance. */
  wasNewPlayer?: boolean;
  /** Live lobby balance (`PlayerRating.isNewPlayer`). */
  isNewPlayer?: boolean;
  isQuitter?: boolean;
};

/** True when a seat is flagged New for balance (live or snapshot). */
export function isMarkedNewPlayer(
  entry: Pick<NewPlayerPartitionEntry, 'wasNewPlayer' | 'isNewPlayer'>,
): boolean {
  return entry.wasNewPlayer === true || entry.isNewPlayer === true;
}

function newSeatsOnTeam<T extends NewPlayerPartitionEntry>(
  entries: T[],
  team: 1 | 2,
  isNew: (entry: T) => boolean,
): T[] {
  return entries
    .filter((entry) => isNew(entry) && entry.team === team)
    .sort((left, right) => left.slot - right.slot);
}

/**
 * Lowest-slot pair-off keys shared by rating apply and balance.
 * Quitters count toward `k` when present (rating apply); pre-match balance has none.
 */
export function computePairedNewKeys<T extends NewPlayerPartitionEntry>(
  entries: T[],
  isNew: (entry: T) => boolean = isMarkedNewPlayer,
): Set<string> {
  const team1New = newSeatsOnTeam(entries, 1, isNew);
  const team2New = newSeatsOnTeam(entries, 2, isNew);
  const k = Math.min(team1New.length, team2New.length);

  const pairedNewKeys = new Set<string>();
  for (let index = 0; index < k; index += 1) {
    pairedNewKeys.add(entryPairKey(team1New[index]!));
    pairedNewKeys.add(entryPairKey(team2New[index]!));
  }
  return pairedNewKeys;
}

/**
 * Balance path: paired non-quit New are omitted; excess get discounted μ.
 * Uses the same `k` / lowest-slot rules as `partitionRosterForRating`.
 */
export function classifyNewSeatsForBalance<T extends NewPlayerPartitionEntry>(
  entries: T[],
): { frozenKeys: Set<string>; excessKeys: Set<string> } {
  const pairedNewKeys = computePairedNewKeys(entries);
  const frozenKeys = new Set<string>();
  const excessKeys = new Set<string>();

  for (const entry of entries) {
    if (entry.isQuitter || !isMarkedNewPlayer(entry)) {
      continue;
    }
    const key = entryPairKey(entry);
    if (pairedNewKeys.has(key)) {
      frozenKeys.add(key);
    } else {
      excessKeys.add(key);
    }
  }

  return { frozenKeys, excessKeys };
}
