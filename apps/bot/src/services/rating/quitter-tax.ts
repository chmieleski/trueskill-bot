import { applyKiTaxToMu } from './griefer-tax.js';
import { displayOrdinal } from './rating-math.js';

/** KI loss applied recursively for each quitter-marked game at season rollover. */
export const QUITTER_SEASON_TAX_PERCENT = 0.1;

/** Apply one 10% reduction per quitter incident, rounding each step like displayed KI. */
export function computeQuitterSeasonTaxKi(currentKi: number, quitCount: number): number {
  let nextKi = Math.max(0, currentKi);
  for (let i = 0; i < quitCount && nextKi > 0; i += 1) {
    nextKi = Math.round(nextKi * (1 - QUITTER_SEASON_TAX_PERCENT));
  }
  return Math.max(0, currentKi) - nextKi;
}

export type QuitterIncidentCounts = Map<string, number>;

/** Count flagged quitter match rows by player. */
export function countQuitterIncidents(rows: Array<{ playerId: string }>): QuitterIncidentCounts {
  const counts: QuitterIncidentCounts = new Map();
  for (const row of rows) {
    counts.set(row.playerId, (counts.get(row.playerId) ?? 0) + 1);
  }
  return counts;
}

/** Compute each player's pending season tax from their current public KI. */
export function quitterSeasonTaxByPlayer(
  ratings: Array<{ playerId: string; mu: number; sigma: number }>,
  incidentCounts: QuitterIncidentCounts,
  gamesByPlayer: Map<string, number>,
): Map<string, number> {
  const taxByPlayer = new Map<string, number>();
  for (const row of ratings) {
    const count = incidentCounts.get(row.playerId) ?? 0;
    const games = gamesByPlayer.get(row.playerId) ?? 0;
    const ki = displayOrdinal(row.mu, row.sigma, games);
    const tax = computeQuitterSeasonTaxKi(ki, count);
    if (tax > 0) {
      taxByPlayer.set(row.playerId, tax);
    }
  }
  return taxByPlayer;
}

export function summarizeQuitterSeasonTax(taxByPlayer: Map<string, number>): {
  playerCount: number;
  totalKiTax: number;
} {
  let totalKiTax = 0;
  for (const tax of taxByPlayer.values()) {
    totalKiTax += tax;
  }
  return { playerCount: taxByPlayer.size, totalKiTax };
}

/** Apply the same recursively rounded KI tax to ending-season global μ. */
export function applyQuitterSeasonTaxToSeededGlobals(
  seeded: Array<{ playerId: string; mu: number; sigma: number }>,
  incidentCounts: QuitterIncidentCounts,
  gamesByPlayer: Map<string, number>,
): Array<{ playerId: string; mu: number; sigma: number }> {
  return seeded.map((row) => {
    const count = incidentCounts.get(row.playerId) ?? 0;
    const games = gamesByPlayer.get(row.playerId) ?? 0;
    const ki = displayOrdinal(row.mu, row.sigma, games);
    const tax = computeQuitterSeasonTaxKi(ki, count);
    return tax > 0 ? { ...row, mu: applyKiTaxToMu(row.mu, row.sigma, games, tax) } : row;
  });
}
