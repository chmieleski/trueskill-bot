import { isCalibrating } from './rating-math.js';

/** Ki offset from lobby average at which scaling reaches full effect. */
export const LOBBY_OFFSET_KI_FULL_EFFECT = 2000;

export const LOBBY_SCALE_MIN = 0.75;
export const LOBBY_SCALE_MAX = 1.25;
export const LOBBY_SCALE_WIN_COEFF = 0.25;
export const LOBBY_SCALE_LOSS_COEFF = 0.25;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Normalized lobby offset in [-1, 1]. */
export function lobbyOffsetT(offsetKi: number): number {
  return clamp(offsetKi / LOBBY_OFFSET_KI_FULL_EFFECT, -1, 1);
}

/** Above lobby avg → scale < 1 (smaller win gains). */
export function lobbyScaleWin(offsetKi: number): number {
  const t = lobbyOffsetT(offsetKi);
  return clamp(1 - LOBBY_SCALE_WIN_COEFF * t, LOBBY_SCALE_MIN, LOBBY_SCALE_MAX);
}

/** Above lobby avg → scale > 1 (larger losses). */
export function lobbyScaleLoss(offsetKi: number): number {
  const t = lobbyOffsetT(offsetKi);
  return clamp(1 + LOBBY_SCALE_LOSS_COEFF * t, LOBBY_SCALE_MIN, LOBBY_SCALE_MAX);
}

/**
 * Ki values that feed lobby average: calibrated players only.
 * If everyone is still calibrating, fall back to all so avg is not 0.
 */
export function kisForLobbyAverage(
  players: ReadonlyArray<{ ki: number; games: number }>,
): number[] {
  const calibrated = players
    .filter((player) => !isCalibrating(player.games))
    .map((player) => player.ki);
  if (calibrated.length > 0) {
    return calibrated;
  }
  return players.map((player) => player.ki);
}

/** Arithmetic mean of pre-match global ki values; 0 when empty. */
export function computeLobbyAvgKi(preMatchGlobalKis: number[]): number {
  if (preMatchGlobalKis.length === 0) {
    return 0;
  }
  return preMatchGlobalKis.reduce((sum, ki) => sum + ki, 0) / preMatchGlobalKis.length;
}

/**
 * Apply lobby-relative scaling to OpenSkill μ result.
 * Caller keeps σ unchanged.
 */
export function scaleAppliedMu(
  beforeMu: number,
  afterMu: number,
  won: boolean,
  offsetKi: number,
): number {
  const delta = afterMu - beforeMu;
  const scale = won ? lobbyScaleWin(offsetKi) : lobbyScaleLoss(offsetKi);
  return beforeMu + delta * scale;
}
