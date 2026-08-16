export type MuSigma = { mu: number; sigma: number };

/**
 * OpenSkill entities for one roster player: global only when `heroId` is null,
 * otherwise the dual [global, hero] pair (stride 2).
 */
export function ratingEntitiesForPlayer(
  global: MuSigma,
  hero: MuSigma,
  heroId: number | null,
): MuSigma[] {
  if (heroId == null) {
    return [global];
  }
  return [global, hero];
}

/**
 * Roster rows that have a catalog hero (hero rating entity exists).
 */
export function rosterEntriesWithHeroId<T extends { heroId: number | null }>(
  entries: T[],
): Array<T & { heroId: number }> {
  return entries.filter((entry): entry is T & { heroId: number } => entry.heroId != null);
}
