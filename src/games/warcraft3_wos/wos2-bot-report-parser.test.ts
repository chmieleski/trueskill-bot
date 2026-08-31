import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseWos2BotReport,
  winningTeamFromWos2Rounds,
  Wos2BotReportParseError,
} from './wos2-bot-report-parser.js';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/wos2-bot-sample.txt');
const sampleRaw = readFileSync(samplePath, 'utf8');

describe('parseWos2BotReport', () => {
  it('parses the real WOS2 bot sample export', () => {
    const report = parseWos2BotReport(sampleRaw);

    expect(report.format).toBe('WOS2_BOT_V1');
    expect(report.externalId).toBe('34508754-98989487-41346570-71702689');
    expect(report.team1Rounds).toBe(2);
    expect(report.team2Rounds).toBe(10);
    expect(report.playerCount).toBe(2);
    expect(report.players).toHaveLength(2);

    expect(report.players[0]).toMatchObject({
      name: 'Chmieleski#1941',
      team: 1,
      win: false,
      left: false,
      teamSlot: null,
      heroName: 'Raiden Ei',
      kills: 1,
      deaths: 10,
      itemSlots: [1227894850, 1227895116, 1227895106, 1227895091, 1227894871, 1227895121],
    });

    expect(report.players[1]).toMatchObject({
      name: 'Tiny#11318',
      team: 2,
      win: true,
      heroName: 'Frieren',
      kills: 0,
      deaths: 2,
      itemSlots: [1227894863, 1227894873, 0, 0, 0, 0],
    });
  });

  it('parses ITEM_RATE lines into itemRates', () => {
    const report = parseWos2BotReport(sampleRaw);
    expect(report.itemRates).toEqual(
      expect.arrayContaining([
        { objectId: 1227894850, name: 'Oken' },
        { objectId: 1227894873, name: "Angel's Blessing" },
      ]),
    );
    expect(report.itemRates).toHaveLength(8);
  });

  it('derives team 2 as winner from round scores', () => {
    const report = parseWos2BotReport(sampleRaw);
    expect(winningTeamFromWos2Rounds(report)).toBe(2);
  });

  it('rejects unsupported formats', () => {
    expect(() => parseWos2BotReport('ID|value=abc|format=OTHER|scope=MATCH\nEND|id=abc')).toThrow(
      Wos2BotReportParseError,
    );
  });

  it('parses schema 2 player rows with team_slot and left', () => {
    const report = parseWos2BotReport(
      'ID|value=abc|format=WOS2_BOT_V1|scope=MATCH\n' +
        'MATCH|team1_rounds=2|team2_rounds=10|players=3|schema=2\n' +
        'PLAYER|n=2|pid=1|name=LavaShark#211786|team=1|win=0|left=1|team_slot=2\n' +
        'STATS|n=2|pid=1|kills=1|deaths=9|damage_phys=0|damage_magic=0|damage_total=0|heal=0|taken_phys=0|taken_magic=0|taken_total=0\n' +
        'ITEMS|n=2|pid=1|slot1=0|slot2=0|slot3=0|slot4=0|slot5=0|slot6=0\n' +
        'END|id=abc',
    );

    expect(report.players[0]).toMatchObject({
      name: 'LavaShark#211786',
      team: 1,
      left: true,
      teamSlot: 2,
    });
  });

  it('rejects mismatched END id', () => {
    expect(() =>
      parseWos2BotReport('ID|value=abc|format=WOS2_BOT_V1|scope=MATCH\nEND|id=xyz'),
    ).toThrow(/do not match/);
  });
});
