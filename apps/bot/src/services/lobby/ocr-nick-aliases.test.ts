import { describe, expect, it } from 'vitest';
import { MatchServiceError } from '../match/match-service.js';
import type { LobbyPlayer } from './lobby-ocr.js';
import {
  applyOcrNickAliases,
  formatOcrNickAliasLines,
  normalizeOcrNickAliasPair,
} from './ocr-nick-aliases.js';

describe('normalizeOcrNickAliasPair', () => {
  it('normalizes from/to with the same rules as Player nicks', () => {
    expect(normalizeOcrNickAliasPair('  B0jan#1234 ', ' Bojan ')).toEqual({
      fromNick: 'b0jan',
      toNick: 'bojan',
    });
  });

  it('rejects empty from or to after normalize', () => {
    expect(() => normalizeOcrNickAliasPair('   ', 'bojan')).toThrow(MatchServiceError);
    expect(() => normalizeOcrNickAliasPair('b0jan', '  ')).toThrow(MatchServiceError);
  });

  it('rejects identity mappings', () => {
    expect(() => normalizeOcrNickAliasPair('Bojan', 'bojan')).toThrow(MatchServiceError);
  });
});

describe('applyOcrNickAliases', () => {
  const players: LobbyPlayer[] = [
    { slot: 1, nick: 'b0jan', locked: true },
    { slot: 2, nick: 'goku' },
  ];

  it('rewrites exact fromNick hits and preserves other fields', () => {
    const map = new Map([['b0jan', 'bojan']]);
    expect(applyOcrNickAliases(players, map)).toEqual([
      { slot: 1, nick: 'bojan', locked: true },
      { slot: 2, nick: 'goku' },
    ]);
  });

  it('leaves nicks unchanged when no alias matches', () => {
    expect(applyOcrNickAliases(players, new Map())).toEqual(players);
  });

  it('does not mutate the input array or player objects', () => {
    const map = new Map([['b0jan', 'bojan']]);
    const before = structuredClone(players);
    applyOcrNickAliases(players, map);
    expect(players).toEqual(before);
  });
});

describe('formatOcrNickAliasLines', () => {
  it('returns unset when empty', () => {
    expect(formatOcrNickAliasLines([])).toEqual(['`unset`']);
  });

  it('formats sorted alias lines', () => {
    expect(
      formatOcrNickAliasLines([
        { fromNick: 'zulu', toNick: 'z' },
        { fromNick: 'b0jan', toNick: 'bojan' },
      ]),
    ).toEqual(['`b0jan` → `bojan`', '`zulu` → `z`']);
  });
});
