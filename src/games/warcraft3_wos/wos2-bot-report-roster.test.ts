import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';
import { parseWos2BotReport } from './wos2-bot-report-parser.js';
import {
  botSlotFromReportPlayer,
  lobbyPlayersFromWos2Report,
  wc3statsPidToBotSlot,
  Wos2ReportRosterError,
} from './wos2-bot-report-roster.js';

const legacySampleRaw = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures/wos2-bot-sample.txt'),
  'utf8',
);

const schema2SampleRaw = `ID|value=36221801-90619783-99790372-91410975|format=WOS2_BOT_V1|scope=MATCH
MATCH|team1_rounds=2|team2_rounds=10|players=3|schema=2|teams_reorganized=0
PLAYER|n=1|pid=0|name=ThunderGear#2310|team=1|win=0|hero_id=1211118146|hero_name=Brandish|left=0|lobby_slot=0|team_slot=1|visual_slot=0
STATS|n=1|pid=0|rounds_played=12|round_wins=2|round_losses=10|kills=0|deaths=10|damage_phys=1581|damage_magic=0|damage_total=1581|heal=80|taken_phys=1342|taken_magic=977|taken_total=2319
ITEMS|n=1|pid=0|slot1=1227894863|slot2=1227894856|slot3=1227895117|slot4=1227894861|slot5=1227895089|slot6=1227895636
PLAYER|n=2|pid=1|name=LavaShark#211786|team=1|win=0|hero_id=1211117634|hero_name=Artoria (Alter)|left=1|lobby_slot=1|team_slot=2|visual_slot=1
STATS|n=2|pid=1|rounds_played=10|round_wins=2|round_losses=8|kills=1|deaths=9|damage_phys=1419|damage_magic=0|damage_total=1419|heal=0|taken_phys=982|taken_magic=763|taken_total=1745
ITEMS|n=2|pid=1|slot1=1227894863|slot2=1227895363|slot3=1227894868|slot4=1227895113|slot5=1227894861|slot6=1227895636
PLAYER|n=3|pid=5|name=MaSeTeR#2245|team=2|win=1|hero_id=1211118145|hero_name=Patriot|left=0|lobby_slot=5|team_slot=1|visual_slot=5
STATS|n=3|pid=5|rounds_played=12|round_wins=10|round_losses=2|kills=2|deaths=3|damage_phys=2324|damage_magic=1740|damage_total=4064|heal=0|taken_phys=3000|taken_magic=0|taken_total=3000
ITEMS|n=3|pid=5|slot1=1227895348|slot2=1227895121|slot3=1227894863|slot4=1227894861|slot5=1227895636|slot6=1227894868
END|id=36221801-90619783-99790372-91410975`;

describe('wc3statsPidToBotSlot', () => {
  it('maps pid 0 to slot 1 and pid 5 to slot 6', () => {
    expect(wc3statsPidToBotSlot(0)).toBe(1);
    expect(wc3statsPidToBotSlot(5)).toBe(6);
  });

  it('throws for unknown pid', () => {
    expect(() => wc3statsPidToBotSlot(99)).toThrow(Wos2ReportRosterError);
  });
});

describe('botSlotFromReportPlayer', () => {
  const profile = getGameProfile(WARCRAFT3_WOS_GAME_ID);

  it('uses team + team_slot instead of lobby pid when team_slot is present', () => {
    const report = parseWos2BotReport(schema2SampleRaw);
    const draftedToTeamB = report.players.find((player) => player.name.startsWith('MaSeTeR'));

    expect(draftedToTeamB).toBeDefined();
    expect(botSlotFromReportPlayer(profile, draftedToTeamB!)).toBe(6);
  });

  it('falls back to pid when team_slot is absent (legacy exports)', () => {
    const report = parseWos2BotReport(legacySampleRaw);
    expect(botSlotFromReportPlayer(profile, report.players[0])).toBe(1);
    expect(botSlotFromReportPlayer(profile, report.players[1])).toBe(6);
  });
});

describe('lobbyPlayersFromWos2Report', () => {
  it('builds lobby players from legacy report via pid fallback', () => {
    const profile = getGameProfile(WARCRAFT3_WOS_GAME_ID);
    const report = parseWos2BotReport(legacySampleRaw);
    const players = lobbyPlayersFromWos2Report(report, profile);

    expect(players).toEqual([
      { slot: 1, nick: 'chmieleski' },
      { slot: 6, nick: 'tiny' },
    ]);
  });

  it('assigns slots from report team + team_slot without auto-flagging quitters', () => {
    const profile = getGameProfile(WARCRAFT3_WOS_GAME_ID);
    const report = parseWos2BotReport(schema2SampleRaw);
    const players = lobbyPlayersFromWos2Report(report, profile);

    expect(players).toEqual([
      { slot: 1, nick: 'thundergear' },
      { slot: 2, nick: 'lavashark' },
      { slot: 6, nick: 'maseter' },
    ]);
  });

  it('requires at least one player per team', () => {
    const profile = getGameProfile(WARCRAFT3_WOS_GAME_ID);
    const report = parseWos2BotReport(legacySampleRaw);
    report.players = report.players.filter((player) => player.team === 1);

    expect(() => lobbyPlayersFromWos2Report(report, profile)).toThrow(Wos2ReportRosterError);
  });
});
