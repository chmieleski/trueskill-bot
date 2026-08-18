import { describe, expect, it } from 'vitest';
import {
  computeLobbyAvgKi,
  lobbyScaleLoss,
  lobbyScaleWin,
  scaleAppliedMu,
} from './lobby-relative-scale.js';

describe('lobbyScaleWin', () => {
  it('returns 0.5 at +2000 ki above lobby', () => {
    expect(lobbyScaleWin(2000)).toBe(0.5);
  });

  it('returns 1.0 at lobby average', () => {
    expect(lobbyScaleWin(0)).toBe(1);
  });

  it('returns 1.5 at -2000 ki below lobby', () => {
    expect(lobbyScaleWin(-2000)).toBe(1.5);
  });
});

describe('lobbyScaleLoss', () => {
  it('returns 1.5 at +2000 ki above lobby', () => {
    expect(lobbyScaleLoss(2000)).toBe(1.5);
  });

  it('returns 1.0 at lobby average', () => {
    expect(lobbyScaleLoss(0)).toBe(1);
  });

  it('returns 0.5 at -2000 ki below lobby', () => {
    expect(lobbyScaleLoss(-2000)).toBe(0.5);
  });
});

describe('scaleAppliedMu', () => {
  it('shrinks a win gain when above lobby avg', () => {
    const scaled = scaleAppliedMu(30, 30.4, true, 2000);
    expect(scaled).toBeCloseTo(30.2, 5);
  });

  it('amplifies a loss when above lobby avg', () => {
    const scaled = scaleAppliedMu(30, 29.6, false, 2000);
    expect(scaled).toBeCloseTo(29.4, 5);
  });
});

describe('computeLobbyAvgKi', () => {
  it('averages pre-match global ki values', () => {
    expect(computeLobbyAvgKi([5000, 2000, 2000])).toBeCloseTo(3000, 5);
  });

  it('returns 0 for an empty lobby', () => {
    expect(computeLobbyAvgKi([])).toBe(0);
  });
});
