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
      'griefers',
      'complete',
      'upload_report',
      'cancel',
      'flip',
      'void',
      'ungrief',
      'unquit',
    ]);
  });

  it('history subcommand accepts user and nick lookup options', () => {
    const json = data.toJSON();
    const history = json.options?.find((option) => option.name === 'history');
    const optionNames = history?.options?.map((option) => option.name);

    expect(optionNames).toContain('user');
    expect(optionNames).toContain('nick');
    expect(optionNames).toContain('griefers_only');
  });

  it('cancel subcommand takes griefers slots', () => {
    const json = data.toJSON();
    const cancel = json.options?.find((option) => option.name === 'cancel');
    const optionNames = cancel?.options?.map((option) => option.name);

    expect(optionNames).toContain('griefers');
    expect(optionNames).not.toContain('abusers');
  });

  it('complete subcommand takes quitters and griefers slots', () => {
    const json = data.toJSON();
    const complete = json.options?.find((option) => option.name === 'complete');
    const optionNames = complete?.options?.map((option) => option.name);

    expect(optionNames).toContain('quitters');
    expect(optionNames).toContain('griefers');
  });
});
