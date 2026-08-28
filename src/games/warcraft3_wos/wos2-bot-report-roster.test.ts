import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';
import { parseWos2BotReport } from './wos2-bot-report-parser.js';
import {
  lobbyPlayersFromWos2Report,
  wc3statsPidToBotSlot,
  Wos2ReportRosterError,
} from './wos2-bot-report-roster.js';

const sampleRaw = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures/wos2-bot-sample.txt'),
  'utf8',
);

describe('wc3statsPidToBotSlot', () => {
  it('maps pid 0 to slot 1 and pid 5 to slot 6', () => {
    expect(wc3statsPidToBotSlot(0)).toBe(1);
    expect(wc3statsPidToBotSlot(5)).toBe(6);
  });

  it('throws for unknown pid', () => {
    expect(() => wc3statsPidToBotSlot(99)).toThrow(Wos2ReportRosterError);
  });
});

describe('lobbyPlayersFromWos2Report', () => {
  it('builds lobby players from sample report', () => {
    const profile = getGameProfile(WARCRAFT3_WOS_GAME_ID);
    const report = parseWos2BotReport(sampleRaw);
    const players = lobbyPlayersFromWos2Report(report, profile);

    expect(players).toEqual([
      { slot: 1, nick: 'chmieleski' },
      { slot: 6, nick: 'tiny' },
    ]);
  });

  it('requires at least one player per team', () => {
    const profile = getGameProfile(WARCRAFT3_WOS_GAME_ID);
    const report = parseWos2BotReport(sampleRaw);
    report.players = report.players.filter((player) => player.team === 1);

    expect(() => lobbyPlayersFromWos2Report(report, profile)).toThrow(Wos2ReportRosterError);
  });
});
