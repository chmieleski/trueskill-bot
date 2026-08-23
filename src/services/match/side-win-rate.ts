import { winRatePercent } from '../rating/rank-reset-display.js';

export const SIDE_WR_LAST_N = 20;

export type LeagueSideWindow = {
  team1Wins: number;
  team2Wins: number;
  windowSize: number;
};

export type LeagueSideWinRate = {
  season: LeagueSideWindow;
  lastN: LeagueSideWindow;
};

/** Winner team when at least one WIN exists; otherwise null (do not dump onto team 2). */
export function winningTeamIfPresent(
  players: Array<{ team: number; result: string | null }>,
): 1 | 2 | null {
  if (players.some((p) => p.result === 'WIN' && p.team === 1)) return 1;
  if (players.some((p) => p.result === 'WIN' && p.team === 2)) return 2;
  return null;
}

function countWindow(
  matches: Array<{ players: Array<{ team: number; result: string | null }> }>,
): LeagueSideWindow {
  let team1Wins = 0;
  let team2Wins = 0;
  for (const match of matches) {
    const winner = winningTeamIfPresent(match.players);
    if (winner === 1) team1Wins += 1;
    else if (winner === 2) team2Wins += 1;
  }
  return { team1Wins, team2Wins, windowSize: matches.length };
}

/**
 * Aggregate season + last-N side wins.
 * `matches` must be newest-first (same order as `/match list`).
 */
export function aggregateLeagueSideWindows(
  matches: Array<{ players: Array<{ team: number; result: string | null }> }>,
  lastN: number = SIDE_WR_LAST_N,
): LeagueSideWinRate {
  const season = countWindow(matches);
  const lastSlice = matches.slice(0, Math.min(lastN, matches.length));
  return { season, lastN: countWindow(lastSlice) };
}

function formatSideWindow(
  window: LeagueSideWindow,
  teamLabelFor: (team: 1 | 2) => string,
): string {
  const { team1Wins, team2Wins } = window;
  if (team1Wins === team2Wins) {
    const wr = winRatePercent(team1Wins, team2Wins);
    const wrText = wr === null ? '' : ` (${wr}%)`;
    return `Tied ${team1Wins}–${team2Wins}${wrText}`;
  }
  if (team1Wins > team2Wins) {
    const wr = winRatePercent(team1Wins, team2Wins);
    return `${teamLabelFor(1)} ${team1Wins}–${team2Wins} (${wr}%)`;
  }
  const wr = winRatePercent(team2Wins, team1Wins);
  return `${teamLabelFor(2)} ${team2Wins}–${team1Wins} (${wr}%)`;
}

/** Description line for `/match list`, or null when the league has no completed matches. */
export function formatLeagueSideWinRateLine(
  stats: LeagueSideWinRate,
  teamLabelFor: (team: 1 | 2) => string,
): string | null {
  if (stats.season.windowSize === 0) return null;
  const season = formatSideWindow(stats.season, teamLabelFor);
  const last = formatSideWindow(stats.lastN, teamLabelFor);
  return `${season} · Last ${stats.lastN.windowSize}: ${last}`;
}
