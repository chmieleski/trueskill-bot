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
