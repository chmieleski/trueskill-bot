export type MuSigma = { mu: number; sigma: number };

/** Player (league-global) share of `predictWin` / balance-hint team strength. */
export const BALANCE_PLAYER_WEIGHT = 0.8;

/** Hero share of `predictWin` / balance-hint team strength. */
export const BALANCE_HERO_WEIGHT = 0.2;

/** Fixed σ for predictWin when a league enables static balance certainty. */
export const BALANCE_STATIC_SIGMA = 6;

/** Options for lobby win% / balance hints only (not `rate()`). */
export type BalancePredictWinOptions = {
  /** When true, every seat uses {@link BALANCE_STATIC_SIGMA} instead of persisted σ. */
  staticSigma?: boolean;
};

/** Overall OpenSkill entity for `rate()` / overall synthetics (hero-agnostic). */
export function ratingEntitiesForOverall(global: MuSigma): MuSigma[] {
  return [global];
}

/** Hero OpenSkill entity for `rate()` / hero synthetics. */
export function ratingEntitiesForHero(hero: MuSigma): MuSigma[] {
  return [hero];
}

function balanceSigmaForEntity(dynamicSigma: number, options?: BalancePredictWinOptions): number {
  return options?.staticSigma ? BALANCE_STATIC_SIGMA : dynamicSigma;
}

/**
 * Weighted Gaussian for lobby win% / balance hints: 80% player μ + 20% hero μ.
 * σ is blended from persisted values unless `staticSigma` is set.
 * Does not change persisted ratings or `rate()`.
 */
export function blendedRatingForBalance(
  global: MuSigma,
  hero: MuSigma,
  options?: BalancePredictWinOptions,
): MuSigma {
  const mu = BALANCE_PLAYER_WEIGHT * global.mu + BALANCE_HERO_WEIGHT * hero.mu;
  if (options?.staticSigma) {
    return { mu, sigma: BALANCE_STATIC_SIGMA };
  }
  return {
    mu,
    sigma: Math.sqrt(
      (BALANCE_PLAYER_WEIGHT * global.sigma) ** 2 + (BALANCE_HERO_WEIGHT * hero.sigma) ** 2,
    ),
  };
}

/**
 * `predictWin` team entities: one 80/20 blend when the slot has a hero,
 * otherwise global only (WOS).
 */
export function ratingEntitiesForBalance(
  global: MuSigma,
  hero: MuSigma,
  heroId: number | null,
  options?: BalancePredictWinOptions,
): MuSigma[] {
  if (heroId == null) {
    return [{ mu: global.mu, sigma: balanceSigmaForEntity(global.sigma, options) }];
  }
  return [blendedRatingForBalance(global, hero, options)];
}

/**
 * Roster rows that have a catalog hero (hero rating entity exists).
 */
export function rosterEntriesWithHeroId<T extends { heroId: number | null }>(
  entries: T[],
): Array<T & { heroId: number }> {
  return entries.filter((entry): entry is T & { heroId: number } => entry.heroId != null);
}
