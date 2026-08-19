import { rating, type Rating } from 'openskill';

/** Display offset so cold-start OpenSkill ordinal 0 maps to ~1000 ki. */
export const KI_OFFSET = 1000;

/** Scale so elite ordinal (~35) lands near 8000 ki. */
export const KI_SCALE = 200;

/** Conservatism z at 0 games (classic OpenSkill μ − 3σ). */
export const KI_Z_START = 3;

/** Conservatism z after the blend window (softer public ordinal). */
export const KI_Z_END = 2.5;

/** Completed games over which z slides from START → END. */
export const KI_Z_BLEND_GAMES = 5;

/** Public stand-in for ki while `isCalibrating` is true. */
export const CALIBRATING_LABEL = 'Calibrating';

/**
 * True while the player has fewer than {@link KI_Z_BLEND_GAMES} completed
 * league games. Display-only; does not affect OpenSkill rate().
 */
export function isCalibrating(matchesPlayed: number): boolean {
  return Math.max(0, matchesPlayed) < KI_Z_BLEND_GAMES;
}

/**
 * Public ki cell: the word Calibrating until 5 league games, then the number.
 */
export function formatPublicKi(ki: number, matchesPlayed: number): string {
  if (isCalibrating(matchesPlayed)) {
    return CALIBRATING_LABEL;
  }
  return String(ki);
}

/**
 * Public display conservatism: blend z from 3 → 2.5 over the first 5 games,
 * then hold at 2.5. Display-only; does not affect OpenSkill rate().
 */
export function displayConservatismZ(matchesPlayed: number): number {
  const games = Math.max(0, matchesPlayed);
  if (games >= KI_Z_BLEND_GAMES) {
    return KI_Z_END;
  }
  const t = games / KI_Z_BLEND_GAMES;
  return KI_Z_START + (KI_Z_END - KI_Z_START) * t;
}

/**
 * Public display rating as themed ki: OFFSET + SCALE × (μ − z·σ).
 * `matchesPlayed` softens z over the first {@link KI_Z_BLEND_GAMES} games.
 * DTO fields may still be named *Ordinal; values are display ki.
 */
export function displayOrdinal(mu: number, sigma: number, matchesPlayed = 0): number {
  const z = displayConservatismZ(matchesPlayed);
  return Math.round(KI_OFFSET + KI_SCALE * (mu - z * sigma));
}

/** Convert μ/σ entities into OpenSkill Rating objects (order preserved). */
export function toOpenSkillRatings(entities: { mu: number; sigma: number }[]): Rating[] {
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

/** Split roster entries into Team A (`team === 1`) and Team B (`team === 2`). */
export function splitRosterByTeam<T extends { slot: number; team: 1 | 2 }>(
  entries: T[],
): { teamA: T[]; teamB: T[] } {
  const sorted = [...entries].sort((a, b) => a.slot - b.slot);
  return {
    teamA: sorted.filter((entry) => entry.team === 1),
    teamB: sorted.filter((entry) => entry.team === 2),
  };
}
