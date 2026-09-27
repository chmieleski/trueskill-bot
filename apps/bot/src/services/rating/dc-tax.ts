import { applyKiTaxToMu } from './griefer-tax.js';

/** DCs required per season tax chunk. */
export const DC_PENALTY_THRESHOLD = 3;

/** Ki deducted per threshold chunk at season rollover. */
export const DC_PENALTY_KI = 300;

/**
 * Flat season-end ki tax from disconnect count: floor(count / 3) × 300.
 */
export function computeDcSeasonTaxKi(dcCount: number): number {
  if (dcCount <= 0) {
    return 0;
  }
  return Math.floor(dcCount / DC_PENALTY_THRESHOLD) * DC_PENALTY_KI;
}

export type DcTaxByPlayer = Map<string, number>;

/** Count DC rows per player, then convert counts to season tax ki. */
export function sumDcSeasonTaxByPlayer(rows: Array<{ playerId: string }>): DcTaxByPlayer {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.playerId, (counts.get(row.playerId) ?? 0) + 1);
  }
  const totals: DcTaxByPlayer = new Map();
  for (const [playerId, count] of counts) {
    const kiTax = computeDcSeasonTaxKi(count);
    if (kiTax > 0) {
      totals.set(playerId, kiTax);
    }
  }
  return totals;
}

export type DcSeasonTaxSummary = {
  playerCount: number;
  totalKiTax: number;
};

/** Build preview totals for pending DC season tax in a league. */
export function summarizeDcSeasonTax(taxByPlayer: DcTaxByPlayer): DcSeasonTaxSummary {
  let totalKiTax = 0;
  for (const kiTax of taxByPlayer.values()) {
    totalKiTax += kiTax;
  }
  return { playerCount: taxByPlayer.size, totalKiTax };
}

/** Apply summed season-end DC ki tax to seeded global μ values. */
export function applyDcSeasonTaxToSeededGlobals(
  seeded: Array<{ playerId: string; mu: number; sigma: number }>,
  taxByPlayer: DcTaxByPlayer,
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
