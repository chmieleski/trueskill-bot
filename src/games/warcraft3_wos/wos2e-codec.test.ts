import { describe, expect, it } from 'vitest';
import { decodeWos2eExport, encodeWos2eExport, Wos2eCodecError } from './wos2e-codec.js';

const matchId = '12345678-23456789-34567890-45678901';
const plainLines = [
  `ID|value=${matchId}|format=WOS2_BOT_V2|scope=MATCH`,
  'MATCH|team1_rounds=2|team2_rounds=1|players=1|schema=2|teams_reorganized=0',
  'PLAYER|n=1|pid=0|name=Test_Player|team=1|win=1|hero_id=1211117616|hero_name=Test Hero|left=0|lobby_slot=0|team_slot=0|visual_slot=0',
  'STATS|n=1|pid=0|rounds_played=3|round_wins=2|round_losses=1|kills=5|deaths=2|damage_phys=100|damage_magic=50|damage_total=150|heal=10|taken_phys=70|taken_magic=20|taken_total=90',
  'ITEMS|n=1|pid=0|slot1=1227894832|slot2=0|slot3=0|slot4=0|slot5=0|slot6=0',
  'ITEM_RATE|item_id=1227894832|item_name=Test Item|games=1|wins=1|winrate_pct=100',
  `END|id=${matchId}`,
];

describe('wos2e-codec', () => {
  it('round-trips encode → decode', () => {
    const encoded = encodeWos2eExport(plainLines, matchId);
    const decoded = decodeWos2eExport(encoded);
    expect(decoded.matchId).toBe(matchId);
    expect(decoded.lines).toEqual(plainLines);
  });

  it('decodes Preload-wrapped containers', () => {
    const encoded = encodeWos2eExport(plainLines, matchId);
    const preloadFile = encoded
      .split('\n')
      .map((line) => `call Preload( "${line}" )`)
      .join('\n');
    expect(decodeWos2eExport(preloadFile).lines).toEqual(plainLines);
  });

  it('rejects tampered ciphertext', () => {
    const encoded = encodeWos2eExport(plainLines, matchId);
    const tampered = encoded.replace(
      /(\|c=)([0-9A-Z])/,
      (_m, prefix: string, ch: string) => `${prefix}${ch === '0' ? '1' : '0'}`,
    );
    expect(() => decodeWos2eExport(tampered)).toThrow(Wos2eCodecError);
    expect(() => decodeWos2eExport(tampered)).toThrow(/invalid authentication tag/);
  });

  it('rejects reordered data lines', () => {
    const encoded = encodeWos2eExport(plainLines, matchId);
    const reordered = encoded.split('\n');
    [reordered[1], reordered[2]] = [reordered[2]!, reordered[1]!];
    expect(() => decodeWos2eExport(reordered.join('\n'))).toThrow(/Invalid sequence/);
  });

  it('rejects truncated containers', () => {
    const encoded = encodeWos2eExport(plainLines, matchId);
    const truncated = encoded.split('\n');
    truncated.splice(2, 1);
    expect(() => decodeWos2eExport(truncated.join('\n'))).toThrow(/Invalid sequence|truncated/);
  });
});
