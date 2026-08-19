import { describe, expect, it } from 'vitest';
import { data, parseQuitterSlots, quitterSlotsFromPlayers } from './match.js';

describe('parseQuitterSlots', () => {
  it('parses comma-separated slots and removes duplicates', () => {
    expect(parseQuitterSlots('1, 3, 7, 3')).toEqual([1, 3, 7]);
  });

  it('returns an empty list for blank input', () => {
    expect(parseQuitterSlots('   ')).toEqual([]);
  });
});

describe('quitterSlotsFromPlayers', () => {
  it('preserves quitters via isQuitter when the option is omitted', () => {
    expect(
      quitterSlotsFromPlayers([
        { slot: 1, isQuitter: true },
        { slot: 3, isQuitter: false },
        { slot: 7, isQuitter: true },
      ]),
    ).toEqual([1, 7]);
  });
});

describe('match command data', () => {
  it('registers the slash subcommands', () => {
    const json = data.toJSON();

    expect(json.name).toBe('match');
    expect(json.options?.map((option) => option.name)).toEqual([
      'history',
      'list',
      'show',
      'quitters',
      'complete',
      'cancel',
      'flip',
      'void',
    ]);
  });
});
