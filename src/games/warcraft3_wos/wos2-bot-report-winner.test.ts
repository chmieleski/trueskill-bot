import { describe, expect, it } from 'vitest';
import { parseWos2BotReport } from './wos2-bot-report-parser.js';
import { inferSuggestedWinner } from './wos2-bot-report-winner.js';
import { encodeWos2eExport } from './wos2e-codec.js';

const matchId = '34508754-98989487-41346570-71702689';
const sampleRaw = encodeWos2eExport(
  [
    `ID|value=${matchId}|format=WOS2_BOT_V2|scope=MATCH`,
    'MATCH|team1_rounds=2|team2_rounds=10|players=2|schema=2|teams_reorganized=0',
    'PLAYER|n=1|pid=0|name=Chmieleski#1941|team=1|win=0|hero_id=1211117616|hero_name=Raiden Ei|left=0|lobby_slot=0|team_slot=1|visual_slot=0',
    'STATS|n=1|pid=0|rounds_played=12|round_wins=2|round_losses=10|kills=1|deaths=10|damage_phys=1660|damage_magic=8174|damage_total=9834|heal=606|taken_phys=1868|taken_magic=2560|taken_total=4428',
    'ITEMS|n=1|pid=0|slot1=1227894850|slot2=0|slot3=0|slot4=0|slot5=0|slot6=0',
    'PLAYER|n=2|pid=5|name=Tiny#11318|team=2|win=1|hero_id=1211118152|hero_name=Frieren|left=0|lobby_slot=5|team_slot=1|visual_slot=5',
    'STATS|n=2|pid=5|rounds_played=12|round_wins=10|round_losses=2|kills=0|deaths=2|damage_phys=1868|damage_magic=2560|damage_total=4428|heal=820|taken_phys=1660|taken_magic=8174|taken_total=9834',
    'ITEMS|n=2|pid=5|slot1=1227894863|slot2=0|slot3=0|slot4=0|slot5=0|slot6=0',
    `END|id=${matchId}`,
  ],
  matchId,
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
