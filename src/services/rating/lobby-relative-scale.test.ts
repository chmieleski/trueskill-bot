import { describe, expect, it } from 'vitest';
import {
  computeLobbyAvgKi,
  kisForLobbyAverage,
  lobbyScaleLoss,
  lobbyScaleWin,
  scaleAppliedMu,
} from './lobby-relative-scale.js';

describe('lobbyScaleWin', () => {
  it('returns 0.75 at +2000 ki above lobby', () => {
    expect(lobbyScaleWin(2000)).toBe(0.75);
  });

  it('returns 1.0 at lobby average', () => {
    expect(lobbyScaleWin(0)).toBe(1);
  });

  it('returns 1.25 at -2000 ki below lobby', () => {
    expect(lobbyScaleWin(-2000)).toBe(1.25);
  });
});

describe('lobbyScaleLoss', () => {
  it('returns 1.25 at +2000 ki above lobby', () => {
    expect(lobbyScaleLoss(2000)).toBe(1.25);
  });

  it('returns 1.0 at lobby average', () => {
    expect(lobbyScaleLoss(0)).toBe(1);
  });

  it('returns 0.75 at -2000 ki below lobby', () => {
    expect(lobbyScaleLoss(-2000)).toBe(0.75);
  });
});

describe('scaleAppliedMu', () => {
  it('shrinks a win gain when above lobby avg', () => {
    const scaled = scaleAppliedMu(30, 30.4, true, 2000);
    expect(scaled).toBeCloseTo(30.3, 5);
  });

  it('amplifies a loss when above lobby avg', () => {
    const scaled = scaleAppliedMu(30, 29.6, false, 2000);
    expect(scaled).toBeCloseTo(29.5, 5);
  });
});

describe('kisForLobbyAverage', () => {
  it('excludes calibrating players from the average set', () => {
    expect(
      kisForLobbyAverage([
        { ki: 5000, games: 20 },
        { ki: 5000, games: 12 },
        { ki: 5000, games: 8 },
        { ki: 5000, games: 5 },
        { ki: 5000, games: 30 },
        { ki: 5000, games: 15 },
        { ki: 5000, games: 9 },
        { ki: 1000, games: 0 },
        { ki: 1000, games: 2 },
        { ki: 1000, games: 4 },
      ]),
    ).toEqual([5000, 5000, 5000, 5000, 5000, 5000, 5000]);
  });

  it('falls back to everyone when the whole lobby is calibrating', () => {
    expect(
      kisForLobbyAverage([
        { ki: 1200, games: 0 },
        { ki: 1400, games: 3 },
      ]),
    ).toEqual([1200, 1400]);
  });
});

describe('computeLobbyAvgKi', () => {
  it('averages pre-match global ki values', () => {
    expect(computeLobbyAvgKi([5000, 2000, 2000])).toBeCloseTo(3000, 5);
  });

  it('returns 0 for an empty lobby', () => {
    expect(computeLobbyAvgKi([])).toBe(0);
  });

  it('is 5k when seven 5k calibrated and three 1k calibrating', () => {
    const kis = kisForLobbyAverage([
      { ki: 5000, games: 20 },
      { ki: 5000, games: 12 },
      { ki: 5000, games: 8 },
      { ki: 5000, games: 5 },
      { ki: 5000, games: 30 },
      { ki: 5000, games: 15 },
      { ki: 5000, games: 9 },
      { ki: 1000, games: 0 },
      { ki: 1000, games: 2 },
      { ki: 1000, games: 4 },
    ]);
    expect(computeLobbyAvgKi(kis)).toBe(5000);
  });
});
