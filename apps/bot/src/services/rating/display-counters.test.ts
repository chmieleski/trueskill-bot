import { describe, expect, it } from 'vitest';
import { countersEqualStats, displayStatsFromCounters } from './display-counters.js';

describe('displayStatsFromCounters', () => {
  it('maps columns to PlayerMatchDisplayStats', () => {
    expect(
      displayStatsFromCounters({
        displayWins: 3,
        displayLosses: 2,
        displayQuits: 1,
        displayGriefs: 0,
        displayDcs: 2,
      }),
    ).toEqual({ games: 5, wins: 3, losses: 2, quits: 1, griefs: 0, dcs: 2 });
  });
});

describe('countersEqualStats', () => {
  it('returns true when equal', () => {
    const s = { games: 5, wins: 3, losses: 2, quits: 1, griefs: 0, dcs: 2 };
    expect(countersEqualStats(s, s)).toBe(true);
  });
  it('returns false when quits differ', () => {
    const a = { games: 1, wins: 1, losses: 0, quits: 0, griefs: 0, dcs: 0 };
    const b = { ...a, quits: 1 };
    expect(countersEqualStats(a, b)).toBe(false);
  });
});
