export type MuSigma = { mu: number; sigma: number };

/** Player (league-global) share of `predictWin` / balance-hint team strength. */
export const BALANCE_PLAYER_WEIGHT = 0.8;

/** Hero share of `predictWin` / balance-hint team strength. */
export const BALANCE_HERO_WEIGHT = 0.2;

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
 * Weighted Gaussian for lobby win% / balance hints: 80% player μ/σ + 20% hero.
 * Does not change persisted ratings or `rate()`.
 */
export function blendedRatingForBalance(global: MuSigma, hero: MuSigma): MuSigma {
  return {
    mu: BALANCE_PLAYER_WEIGHT * global.mu + BALANCE_HERO_WEIGHT * hero.mu,
    sigma: Math.sqrt(
      (BALANCE_PLAYER_WEIGHT * global.sigma) ** 2 + (BALANCE_HERO_WEIGHT * hero.sigma) ** 2,
    ),
  };
}

/**
 * `predictWin` team entities: one 80/20 blend when the slot has a hero,
 * otherwise global only (ACA).
 */
export function ratingEntitiesForBalance(
  global: MuSigma,
  hero: MuSigma,
  heroId: number | null,
): MuSigma[] {
  if (heroId == null) {
    return [global];
  }
  return [blendedRatingForBalance(global, hero)];
}

/**
 * Roster rows that have a catalog hero (hero rating entity exists).
 */
export function rosterEntriesWithHeroId<T extends { heroId: number | null }>(
  entries: T[],
): Array<T & { heroId: number }> {
  return entries.filter((entry): entry is T & { heroId: number } => entry.heroId != null);
}
