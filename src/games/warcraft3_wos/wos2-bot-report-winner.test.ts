import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseWos2BotReport } from './wos2-bot-report-parser.js';
import { inferSuggestedWinner } from './wos2-bot-report-winner.js';

const sampleRaw = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures/wos2-bot-sample.txt'),
  'utf8',
);

describe('inferSuggestedWinner', () => {
  it('uses round scores from the sample report', () => {
    const report = parseWos2BotReport(sampleRaw);
    expect(inferSuggestedWinner(report)).toEqual({ team: 2, source: 'rounds' });
  });

  it('falls back to win flags when rounds are tied', () => {
    const report = parseWos2BotReport(sampleRaw);
    report.team1Rounds = 5;
    report.team2Rounds = 5;
    report.players = [
      { ...report.players[0]!, win: true, team: 1 },
      { ...report.players[1]!, win: false, team: 2 },
    ];

    expect(inferSuggestedWinner(report)).toEqual({ team: 1, source: 'win_flags' });
  });

  it('returns null when inconclusive', () => {
    const report = parseWos2BotReport(sampleRaw);
    report.team1Rounds = null;
    report.team2Rounds = null;
    report.players = [
      { ...report.players[0]!, win: true, team: 1 },
      { ...report.players[1]!, win: true, team: 2 },
    ];

    expect(inferSuggestedWinner(report)).toBeNull();
  });
});
