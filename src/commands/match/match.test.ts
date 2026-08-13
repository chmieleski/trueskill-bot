import { describe, expect, it } from 'vitest';
import { data, parseQuitterSlots } from './match.js';

describe('parseQuitterSlots', () => {
  it('parses comma-separated slots and removes duplicates', () => {
    expect(parseQuitterSlots('1, 3, 7, 3')).toEqual([1, 3, 7]);
  });

  it('returns an empty list for blank input', () => {
    expect(parseQuitterSlots('   ')).toEqual([]);
  });
});

describe('match command data', () => {
  it('registers the slash subcommands', () => {
    const json = data.toJSON();

    expect(json.name).toBe('match');
    expect(json.options?.map((option) => option.name)).toEqual([
      'quitters',
      'complete',
      'cancel',
    ]);
  });
});
