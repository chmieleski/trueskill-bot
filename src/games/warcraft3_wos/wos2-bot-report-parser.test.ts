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

  it('rejects mismatched END id', () => {
    expect(() =>
      parseWos2BotReport('ID|value=abc|format=WOS2_BOT_V1|scope=MATCH\nEND|id=xyz'),
    ).toThrow(/do not match/);
  });
});
