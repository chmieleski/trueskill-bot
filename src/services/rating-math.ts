import { ordinal, rating, type Rating } from 'openskill';

const TEAM_A_MAX_SLOT = 6;

/** Public display ordinal (μ − 3σ), nearest integer. */
export function displayOrdinal(mu: number, sigma: number): number {
  return Math.round(ordinal({ mu, sigma }));
}

/** Convert μ/σ entities into OpenSkill Rating objects (order preserved). */
export function toOpenSkillRatings(
  entities: { mu: number; sigma: number }[],
): Rating[] {
  return entities.map((entity) => rating({ mu: entity.mu, sigma: entity.sigma }));
}

/**
 * Round two win probabilities in [0,1] to integer percents that sum to 100.
 * Round A, assign B the residual so the pair always sums to 100.
 */
export function roundWinPercents(
  pA: number,
  _pB: number,
): { teamAPercent: number; teamBPercent: number } {
  const teamAPercent = Math.round(pA * 100);
  return { teamAPercent, teamBPercent: 100 - teamAPercent };
}

/** Split roster entries into Team A (slots 1–6) and Team B (slots 7–12). */
export function splitRosterByTeam<T extends { slot: number }>(
  entries: T[],
): { teamA: T[]; teamB: T[] } {
  const sorted = [...entries].sort((a, b) => a.slot - b.slot);
  return {
    teamA: sorted.filter((entry) => entry.slot <= TEAM_A_MAX_SLOT),
    teamB: sorted.filter((entry) => entry.slot > TEAM_A_MAX_SLOT),
  };
}
