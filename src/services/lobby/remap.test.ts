import { describe, expect, it } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import {
  WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID,
  WARCRAFT3_UDBR_GAME_ID,
} from '../../domain/games.js';
import { MatchServiceError } from '../match/match-service.js';
import type { LobbyPlayer } from './lobby-ocr.js';
import { parseRemapPairs, resolveRemapSide } from './remap.js';

const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);
const aca = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);

function roster(...rows: Array<[number, string]>): LobbyPlayer[] {
  return rows.map(([slot, nick]) => ({ slot, nick }));
}

describe('resolveRemapSide', () => {
  it('treats in-range integers as slots', () => {
    expect(resolveRemapSide('7', roster([1, 'a']), udbr)).toBe(7);
  });

  it('rejects out-of-range integer tokens as invalid slots, not nicks', () => {
    expect(() => resolveRemapSide('99', roster([1, '99']), udbr)).toThrow(
      'Invalid slot. This game uses slots 1–12.',
    );
    expect(() => resolveRemapSide('11', [], aca)).toThrow(
      'Invalid slot. This game uses slots 1–10.',
    );
  });

  it('resolves a nick to the occupant slot', () => {
    expect(resolveRemapSide('Gohan', roster([3, 'gohan']), udbr)).toBe(3);
  });

  it('rejects an unknown nick', () => {
    expect(() => resolveRemapSide('Gohan', roster([1, 'vegeta']), udbr)).toThrow(
      'No player with nick "gohan" in the lobby.',
    );
  });

  it('never treats token 7 as nick 7', () => {
    expect(resolveRemapSide('7', roster([8, '7']), udbr)).toBe(7);
  });

  it('treats 0 and leading zeros as nicks, not slots', () => {
    expect(resolveRemapSide('07', roster([4, '07']), udbr)).toBe(4);
    expect(() => resolveRemapSide('0', [], udbr)).toThrow(
      'No player with nick "0" in the lobby.',
    );
  });
});

describe('parseRemapPairs', () => {
  it('splits comma pairs and last hyphen, trimming whitespace', () => {
    expect(parseRemapPairs('1-7, 5-4')).toEqual([
      { raw: '1-7', left: '1', right: '7' },
      { raw: '5-4', left: '5', right: '4' },
    ]);
  });

  it('keeps hyphenated nicks by splitting on the last dash', () => {
    expect(parseRemapPairs('cool-guy-7')).toEqual([
      { raw: 'cool-guy-7', left: 'cool-guy', right: '7' },
    ]);
  });

  it('trims around the hyphen', () => {
    expect(parseRemapPairs('1 - 7')).toEqual([
      { raw: '1 - 7', left: '1', right: '7' },
    ]);
  });

  it('rejects empty or whitespace input', () => {
    expect(() => parseRemapPairs('')).toThrow(MatchServiceError);
    expect(() => parseRemapPairs('   ')).toThrow('pairs cannot be empty.');
  });

  it('rejects empty comma segments', () => {
    expect(() => parseRemapPairs('1-7,')).toThrow('Invalid pair "". Use like 1-7 or Gohan-4.');
    expect(() => parseRemapPairs(',1-7')).toThrow('Invalid pair "". Use like 1-7 or Gohan-4.');
  });

  it('rejects a missing hyphen or empty side', () => {
    expect(() => parseRemapPairs('17')).toThrow(
      'Invalid pair "17". Use like 1-7 or Gohan-4.',
    );
    expect(() => parseRemapPairs('-7')).toThrow(
      'Invalid pair "-7". Use like 1-7 or Gohan-4.',
    );
    expect(() => parseRemapPairs('1-')).toThrow(
      'Invalid pair "1-". Use like 1-7 or Gohan-4.',
    );
  });
});
