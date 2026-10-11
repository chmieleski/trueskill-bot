import { displayConservatismZ } from './rating-math.js';

/**
 * `games` = completed games for that rating entity (league-global W/L count or hero
 * `matchesPlayed`). Only read when {@link BalancePredictWinOptions.kiStrength} is on.
 */
export type MuSigma = { mu: number; sigma: number; games?: number };

/** Player (league-global) share of `predictWin` / balance-hint team strength. */
export const BALANCE_PLAYER_WEIGHT = 0.8;

/** Hero share of `predictWin` / balance-hint team strength. */
export const BALANCE_HERO_WEIGHT = 0.2;

/** Fixed σ for predictWin when a league enables static balance certainty. */
export const BALANCE_STATIC_SIGMA = 6;

/** Fraction of blended μ for excess / one-sided New in predictWin / balance hints. */
export const BALANCE_NEW_MU_WEIGHT = 0.8;

/** Ceiling so a mis-flagged high-μ vet cannot dominate win%. */
export const BALANCE_NEW_MU_CAP = 20;

/** Discounted μ for excess / one-sided New on the balance path only. */
export function effectiveBalanceMuForExcessNew(mu: number): number {
  return Math.min(mu * BALANCE_NEW_MU_WEIGHT, BALANCE_NEW_MU_CAP);
}

/** Options for lobby win% / balance hints only (not `rate()`). */
export type BalancePredictWinOptions = {
  /** When true, every seat uses {@link BALANCE_STATIC_SIGMA} instead of persisted σ. */
  staticSigma?: boolean;
  /**
   * When true, each seat is its display-ki strength (μ − z·σ, 80/20 player/hero) with
   * {@link BALANCE_STATIC_SIGMA}; New pair-off / discount are skipped. Overrides `staticSigma`.
   */
  kiStrength?: boolean;
};

/** Display-ki strength in μ units: ki = 1000 + 200 × this (see `displayOrdinal`). */
function kiStrength(entity: MuSigma): number {
  return entity.mu - displayConservatismZ(entity.games ?? 0) * entity.sigma;
}

/**
 * Balance entity scored by display ki: 80% player / 20% hero ki strength (WOS global only),
 * fixed σ so team strength is the ki sum players see. Backtest on UDBR history beat μ/σ.
 */
export function kiStrengthEntityForBalance(
  global: MuSigma,
  hero: MuSigma,
  heroId: number | null,
): MuSigma {
  const mu =
    heroId == null
      ? kiStrength(global)
      : BALANCE_PLAYER_WEIGHT * kiStrength(global) + BALANCE_HERO_WEIGHT * kiStrength(hero);
  return { mu, sigma: BALANCE_STATIC_SIGMA };
}

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
 * Balance entities for one seat after New pair-off: omit frozen, discount excess.
 */
export function balanceEntitiesForSeat(
  global: MuSigma,
  hero: MuSigma,
  heroId: number | null,
  entryKey: string,
  classification: { frozenKeys: Set<string>; excessKeys: Set<string> },
  options?: BalancePredictWinOptions,
): MuSigma[] {
  // Ki already discounts uncertain (New / calibrating) players through z·σ.
  if (options?.kiStrength) {
    return [kiStrengthEntityForBalance(global, hero, heroId)];
  }
  if (classification.frozenKeys.has(entryKey)) {
    return [];
  }

  const entities = ratingEntitiesForBalance(global, hero, heroId, options);
  if (!classification.excessKeys.has(entryKey)) {
    return entities;
  }

  return entities.map((entity) => ({
    ...entity,
    mu: effectiveBalanceMuForExcessNew(entity.mu),
  }));
}

/**
 * Roster rows that have a catalog hero (hero rating entity exists).
 */
export function rosterEntriesWithHeroId<T extends { heroId: number | null }>(
  entries: T[],
): Array<T & { heroId: number }> {
  return entries.filter((entry): entry is T & { heroId: number } => entry.heroId != null);
}
