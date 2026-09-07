import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseWos2BotReport,
  winningTeamFromWos2Rounds,
  Wos2BotReportParseError,
} from './wos2-bot-report-parser.js';
import { encodeWos2eExport } from './wos2e-codec.js';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/wos2-bot-sample.txt');
const sampleRaw = readFileSync(samplePath, 'utf8');

describe('parseWos2BotReport', () => {
  it('parses the real WOS2E sample export', () => {
    const report = parseWos2BotReport(sampleRaw);

    expect(report.format).toBe('WOS2_BOT_V2');
    expect(report.schema).toBe(2);
    expect(report.teamsReorganized).toBe(false);
    expect(report.externalId).toBe('40789973-21466950-72151551-80533748');
    expect(report.team1Rounds).toBe(10);
    expect(report.team2Rounds).toBe(0);
    expect(report.playerCount).toBe(1);
    expect(report.players).toHaveLength(1);

    expect(report.players[0]).toMatchObject({
      name: 'WorldEdit',
      team: 1,
      win: true,
      left: false,
      teamSlot: 1,
      lobbySlot: 0,
      visualSlot: 0,
      heroName: 'Yamamoto Takeshi',
      roundsPlayed: 10,
      roundWins: 10,
      roundLosses: 0,
      kills: 0,
      deaths: 0,
      itemSlots: [1227895627, 0, 0, 0, 0, 0],
    });
  });

  it('parses ITEM_RATE lines into itemRates', () => {
    const report = parseWos2BotReport(sampleRaw);
    expect(report.itemRates).toEqual([
      {
        objectId: 1227895627,
        name: 'Urahara Hat +4',
        games: 1,
        wins: 1,
        winratePct: 100,
      },
    ]);
  });

  it('derives team 1 as winner from round scores in the sample', () => {
    const report = parseWos2BotReport(sampleRaw);
    expect(winningTeamFromWos2Rounds(report)).toBe(1);
  });

  it('rejects plaintext V1 / non-WOS2E input', () => {
    expect(() =>
      parseWos2BotReport('ID|value=abc|format=WOS2_BOT_V1|scope=MATCH\nEND|id=abc'),
    ).toThrow(Wos2BotReportParseError);
  });

  it('parses schema 2 player rows with team_slot and left', () => {
    const matchId = 'abc';
    const encoded = encodeWos2eExport(
      [
        `ID|value=${matchId}|format=WOS2_BOT_V2|scope=MATCH`,
        'MATCH|team1_rounds=2|team2_rounds=10|players=1|schema=2|teams_reorganized=0',
        'PLAYER|n=1|pid=1|name=LavaShark#211786|team=1|win=0|hero_id=0|hero_name=|left=1|lobby_slot=1|team_slot=2|visual_slot=1',
        'STATS|n=1|pid=1|rounds_played=10|round_wins=2|round_losses=8|kills=1|deaths=9|damage_phys=0|damage_magic=0|damage_total=0|heal=0|taken_phys=0|taken_magic=0|taken_total=0',
        'ITEMS|n=1|pid=1|slot1=0|slot2=0|slot3=0|slot4=0|slot5=0|slot6=0',
        `END|id=${matchId}`,
      ],
      matchId,
    );

    const report = parseWos2BotReport(encoded);
    expect(report.players[0]).toMatchObject({
      name: 'LavaShark#211786',
      team: 1,
      left: true,
      teamSlot: 2,
      lobbySlot: 1,
      visualSlot: 1,
    });
  });

  it('rejects mismatched END id', () => {
    const matchId = 'abc';
    const encoded = encodeWos2eExport(
      [
        `ID|value=${matchId}|format=WOS2_BOT_V2|scope=MATCH`,
        'MATCH|team1_rounds=1|team2_rounds=0|players=1|schema=2|teams_reorganized=0',
        'PLAYER|n=1|pid=0|name=A|team=1|win=1|hero_id=1|hero_name=H|left=0|lobby_slot=0|team_slot=1|visual_slot=0',
        'STATS|n=1|pid=0|rounds_played=1|round_wins=1|round_losses=0|kills=0|deaths=0|damage_phys=0|damage_magic=0|damage_total=0|heal=0|taken_phys=0|taken_magic=0|taken_total=0',
        'ITEMS|n=1|pid=0|slot1=0|slot2=0|slot3=0|slot4=0|slot5=0|slot6=0',
        'END|id=xyz',
      ],
      matchId,
    );

    expect(() => parseWos2BotReport(encoded)).toThrow(/END|final END/i);
  });
});
