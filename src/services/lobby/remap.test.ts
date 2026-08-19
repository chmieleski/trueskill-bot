import { describe, expect, it } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import {
  WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID,
  WARCRAFT3_UDBR_GAME_ID,
} from '../../domain/games.js';
import { MatchServiceError } from '../match/match-service.js';
import type { LobbyPlayer } from './lobby-ocr.js';
import { movePlayer } from './roster.js';
import {
  applyRemapPairs,
  parseRemapPairs,
  resolveRemapSide,
  resolveSwapForm,
} from './remap.js';

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

describe('applyRemapPairs', () => {
  it('swaps when the destination is occupied', () => {
    const players = roster([1, 'a'], [7, 'b']);
    expect(applyRemapPairs(players, '1-7', udbr)).toEqual(
      movePlayer(players, 1, 7, udbr),
    );
  });

  it('moves when the destination is empty', () => {
    const players = roster([1, 'a']);
    expect(applyRemapPairs(players, '1-7', udbr)).toEqual(
      movePlayer(players, 1, 7, udbr),
    );
  });

  it('applies overlapping pairs left to right', () => {
    const players = roster([1, 'a'], [7, 'b'], [3, 'c']);
    const afterFirst = movePlayer(players, 1, 7, udbr);
    const expected = movePlayer(afterFirst, 7, 3, udbr);
    expect(applyRemapPairs(players, '1-7, 7-3', udbr)).toEqual(expected);
  });

  it('resolves nicks against the roster after previous pairs', () => {
    const players = roster([1, 'gohan'], [7, 'vegeta']);
    const afterSwap = movePlayer(players, 1, 7, udbr);
    const expected = movePlayer(afterSwap, 7, 4, udbr);
    expect(applyRemapPairs(players, '1-7, Gohan-4', udbr)).toEqual(expected);
  });

  it('moves a hyphenated nick via last-dash parse', () => {
    const players = roster([1, 'cool-guy']);
    expect(applyRemapPairs(players, 'cool-guy-7', udbr)).toEqual(
      movePlayer(players, 1, 7, udbr),
    );
  });

  it('does not wrap parse errors with Could not apply', () => {
    expect(() => applyRemapPairs([], '17', udbr)).toThrow(MatchServiceError);
    try {
      applyRemapPairs([], '17', udbr);
    } catch (error) {
      expect((error as Error).message).toBe(
        'Invalid pair "17". Use like 1-7 or Gohan-4.',
      );
    }
  });

  it('prefixes resolve and move failures with the pair text', () => {
    const players = roster([1, 'a'], [8, '7']);
    expect(() => applyRemapPairs(players, '7-4', udbr)).toThrow(
      'Could not apply 7-4: Slot 7 is empty.',
    );
    expect(() => applyRemapPairs(roster([1, 'a']), 'Gohan-4', udbr)).toThrow(
      'Could not apply Gohan-4: No player with nick "gohan" in the lobby.',
    );
  });

  it('leaves the input array unchanged on failure', () => {
    const players = roster([1, 'a'], [7, 'b']);
    const snapshot = structuredClone(players);
    expect(() => applyRemapPairs(players, '1-7, 99-1', udbr)).toThrow(MatchServiceError);
    expect(players).toEqual(snapshot);
  });
});

describe('resolveSwapForm', () => {
  it('returns classic when both slots are set and pairs is blank', () => {
    expect(resolveSwapForm({ slotA: 1, slotB: 7, pairs: null })).toEqual({
      kind: 'classic',
      slotA: 1,
      slotB: 7,
    });
    expect(resolveSwapForm({ slotA: 1, slotB: 7, pairs: '  ' })).toEqual({
      kind: 'classic',
      slotA: 1,
      slotB: 7,
    });
  });

  it('returns pairs when only pairs is set', () => {
    expect(resolveSwapForm({ slotA: null, slotB: null, pairs: ' 1-7 ' })).toEqual({
      kind: 'pairs',
      pairs: '1-7',
    });
  });

  it('rejects neither form', () => {
    expect(() => resolveSwapForm({ slotA: null, slotB: null, pairs: null })).toThrow(
      'Provide slot_a and slot_b, or pairs.',
    );
  });

  it('rejects both forms', () => {
    expect(() => resolveSwapForm({ slotA: 1, slotB: 7, pairs: '1-7' })).toThrow(
      'Use either slot_a and slot_b, or pairs, not both.',
    );
  });

  it('rejects a single slot option', () => {
    expect(() => resolveSwapForm({ slotA: 1, slotB: null, pairs: null })).toThrow(
      'Provide both slot_a and slot_b, or use pairs instead.',
    );
    expect(() => resolveSwapForm({ slotA: null, slotB: 7, pairs: '1-7' })).toThrow(
      'Use either slot_a and slot_b, or pairs, not both.',
    );
  });
});
