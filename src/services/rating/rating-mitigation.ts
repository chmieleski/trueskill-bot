/** Allowed soft-result mitigation presets (percent of Δμ removed). */
export const RATING_MITIGATION_PERCENTS = [25, 35, 50] as const;

export type RatingMitigationPercent = (typeof RATING_MITIGATION_PERCENTS)[number];

export type RatingMitigationInput = 0 | RatingMitigationPercent;

/**
 * Normalize optional mitigation to a keep-factor input.
 * Invalid values become 0 (no mitigation).
 */
export function normalizeMitigationPercent(
  value: number | null | undefined,
): RatingMitigationInput {
  if (value === 25 || value === 35 || value === 50) {
    return value;
  }
  return 0;
}

/** Fraction of OpenSkill Δμ to keep after mitigation (35 → 0.65). */
export function mitigationKeepFactor(percent: RatingMitigationInput): number {
  if (percent <= 0) {
    return 1;
  }
  return 1 - percent / 100;
}

/**
 * Scale μ delta by mitigation keep-factor. σ is unchanged by the caller.
 * `percent === 0` is a no-op.
 */
export function applyMitigationToMu(
  beforeMu: number,
  afterMu: number,
  percent: RatingMitigationInput,
): number {
  if (percent <= 0) {
    return afterMu;
  }
  const keep = mitigationKeepFactor(percent);
  return beforeMu + (afterMu - beforeMu) * keep;
}
