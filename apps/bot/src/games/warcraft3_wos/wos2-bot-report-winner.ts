import { winningTeamFromWos2Rounds, type Wos2BotReport } from './wos2-bot-report-parser.js';

export type SuggestedWinner = { team: 1 | 2; source: 'rounds' | 'win_flags' };

/** Infer winning team from report round scores, then per-player win flags. */
export function inferSuggestedWinner(report: Wos2BotReport): SuggestedWinner | null {
  const fromRounds = winningTeamFromWos2Rounds(report);
  if (fromRounds !== null) {
    return { team: fromRounds, source: 'rounds' };
  }

  const team1Winners = report.players.filter((player) => player.team === 1 && player.win).length;
  const team2Winners = report.players.filter((player) => player.team === 2 && player.win).length;
  if (team1Winners > 0 && team2Winners === 0) {
    return { team: 1, source: 'win_flags' };
  }
  if (team2Winners > 0 && team1Winners === 0) {
    return { team: 2, source: 'win_flags' };
  }
  return null;
}
