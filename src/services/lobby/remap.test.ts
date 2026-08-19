import { describe, expect, it } from 'vitest';
import { MatchServiceError } from '../match/match-service.js';
import { parseRemapPairs } from './remap.js';

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
