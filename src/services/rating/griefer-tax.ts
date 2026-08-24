import {
  displayConservatismZ,
  displayOrdinal,
  KI_OFFSET,
  KI_SCALE,
} from './rating-math.js';

/** Fraction of global display ki accrued per griefer incident (deferred until season rollover). */
export const GRIEFER_KI_TAX_PERCENT = 0.25;

/** Maximum ki tax per single griefer incident. */
export const GRIEFER_KI_TAX_CAP_KI = 500;

/**
 * Compute deferred ki tax for one griefer incident from the player's global ki at mark time.
 */
export function computeGrieferKiAccrual(globalKi: number): number {
  const raw = Math.round(Math.max(0, globalKi) * GRIEFER_KI_TAX_PERCENT);
  return Math.min(raw, GRIEFER_KI_TAX_CAP_KI);
}

/**
 * Reduce μ so display ki drops by `kiTax`, keeping σ and soft-z (games) unchanged.
 * Clamps resulting ki at 0.
 */
export function applyKiTaxToMu(
  mu: number,
  sigma: number,
  games: number,
  kiTax: number,
): number {
  if (kiTax <= 0) {
    return mu;
  }

  const currentKi = displayOrdinal(mu, sigma, games);
  const targetKi = Math.max(0, currentKi - kiTax);
  const z = displayConservatismZ(games);
  return (targetKi - KI_OFFSET) / KI_SCALE + z * sigma;
}

export type GrieferTaxByPlayer = Map<string, number>;

/** Sum deferred griefer ki accruals per playerId. */
export function sumGrieferKiTaxByPlayer(
  rows: Array<{ playerId: string; grieferKiAccrued: number | null }>,
): GrieferTaxByPlayer {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.grieferKiAccrued == null || row.grieferKiAccrued <= 0) {
      continue;
    }
    totals.set(row.playerId, (totals.get(row.playerId) ?? 0) + row.grieferKiAccrued);
  }
  return totals;
}

export type GrieferSeasonTaxSummary = {
  playerCount: number;
  totalKiTax: number;
};

/** Build preview totals for pending griefer season tax in a league. */
export function summarizeGrieferSeasonTax(taxByPlayer: GrieferTaxByPlayer): GrieferSeasonTaxSummary {
  let totalKiTax = 0;
  for (const kiTax of taxByPlayer.values()) {
    totalKiTax += kiTax;
  }
  return { playerCount: taxByPlayer.size, totalKiTax };
}

/** Apply summed season-end ki tax to seeded global μ values. */
export function applyGrieferSeasonTaxToSeededGlobals(
  seeded: Array<{ playerId: string; mu: number; sigma: number }>,
  taxByPlayer: GrieferTaxByPlayer,
  gamesByPlayer: Map<string, number>,
): Array<{ playerId: string; mu: number; sigma: number }> {
  return seeded.map((row) => {
    const kiTax = taxByPlayer.get(row.playerId) ?? 0;
    if (kiTax <= 0) {
      return row;
    }
    const games = gamesByPlayer.get(row.playerId) ?? 0;
    return {
      ...row,
      mu: applyKiTaxToMu(row.mu, row.sigma, games, kiTax),
    };
  });
}
