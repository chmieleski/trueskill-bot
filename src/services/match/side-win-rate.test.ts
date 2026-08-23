import { describe, expect, it } from 'vitest';
import {
  aggregateLeagueSideWindows,
  formatLeagueSideWinRateLine,
  winningTeamIfPresent,
} from './side-win-rate.js';

const labels = (team: 1 | 2) => (team === 1 ? 'Z Fighters' : 'Evil');

describe('winningTeamIfPresent', () => {
  it('returns the team with a WIN and null when none', () => {
    expect(
      winningTeamIfPresent([
        { team: 1, result: 'LOSS' },
        { team: 2, result: 'WIN' },
      ]),
    ).toBe(2);
    expect(
      winningTeamIfPresent([
        { team: 1, result: null },
        { team: 2, result: null },
      ]),
    ).toBeNull();
  });
});

describe('aggregateLeagueSideWindows', () => {
  it('counts season and last-N winners and skips no-WIN rows in W–L', () => {
    const matches = [
      {
        players: [
          { team: 1, result: 'WIN' as const },
          { team: 2, result: 'LOSS' as const },
        ],
      },
      {
        players: [
          { team: 1, result: 'LOSS' as const },
          { team: 2, result: 'WIN' as const },
        ],
      },
      {
        players: [
          { team: 1, result: null },
          { team: 2, result: null },
        ],
      },
    ];
    const stats = aggregateLeagueSideWindows(matches, 20);
    expect(stats.season).toEqual({ team1Wins: 1, team2Wins: 1, windowSize: 3 });
    expect(stats.lastN).toEqual({ team1Wins: 1, team2Wins: 1, windowSize: 3 });
  });

  it('limits lastN windowSize to the cap', () => {
    const matches = Array.from({ length: 25 }, (_, i) => ({
      players: [
        { team: 1 as const, result: (i % 2 === 0 ? 'WIN' : 'LOSS') as 'WIN' | 'LOSS' },
        { team: 2 as const, result: (i % 2 === 0 ? 'LOSS' : 'WIN') as 'WIN' | 'LOSS' },
      ],
    }));
    const stats = aggregateLeagueSideWindows(matches, 20);
    expect(stats.season.windowSize).toBe(25);
    expect(stats.lastN.windowSize).toBe(20);
    expect(stats.lastN.team1Wins + stats.lastN.team2Wins).toBe(20);
  });
});

describe('formatLeagueSideWinRateLine', () => {
  it('returns null when season is empty', () => {
    expect(
      formatLeagueSideWinRateLine(
        {
          season: { team1Wins: 0, team2Wins: 0, windowSize: 0 },
          lastN: { team1Wins: 0, team2Wins: 0, windowSize: 0 },
        },
        labels,
      ),
    ).toBeNull();
  });

  it('shows season leader and Last N with en dashes', () => {
    const line = formatLeagueSideWinRateLine(
      {
        season: { team1Wins: 34, team2Wins: 25, windowSize: 59 },
        lastN: { team1Wins: 9, team2Wins: 11, windowSize: 20 },
      },
      labels,
    );
    expect(line).toBe('Z Fighters 34–25 (57.6%) · Last 20: Evil 11–9 (55%)');
  });

  it('uses Tied and Last N when under 20 matches', () => {
    const line = formatLeagueSideWinRateLine(
      {
        season: { team1Wins: 6, team2Wins: 6, windowSize: 12 },
        lastN: { team1Wins: 6, team2Wins: 6, windowSize: 12 },
      },
      labels,
    );
    expect(line).toBe('Tied 6–6 (50%) · Last 12: Tied 6–6 (50%)');
  });
});
