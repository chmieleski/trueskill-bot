import { describe, expect, it } from 'vitest';
import { data, parseDcSlots, parseQuitterSlots, quitterSlotsFromPlayers } from './match.js';

describe('parseQuitterSlots', () => {
  it('parses comma-separated slots and removes duplicates', () => {
    expect(parseQuitterSlots('1, 3, 7, 3')).toEqual([1, 3, 7]);
  });

  it('returns an empty list for blank input', () => {
    expect(parseQuitterSlots('   ')).toEqual([]);
  });
});

describe('parseDcSlots', () => {
  it('parses comma-separated slots and removes duplicates', () => {
    expect(parseDcSlots('2, 8, 2')).toEqual([2, 8]);
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
      'dcs',
      'complete',
      'upload_report',
      'cancel',
      'flip',
      'void',
      'ungrief',
      'undc',
      'unquit',
      'sanction',
    ]);
  });

  it('registers sanction add and remove subcommands', () => {
    const json = data.toJSON();
    const sanction = json.options?.find((option) => option.name === 'sanction');
    expect(sanction?.options?.map((option) => option.name)).toEqual(['add', 'remove']);

    const add = sanction?.options?.find((option) => option.name === 'add');
    expect(add?.options?.map((option) => option.name)).toEqual(
      expect.arrayContaining(['type', 'user', 'nick', 'league']),
    );

    const typeOption = add?.options?.find((option) => option.name === 'type') as
      { choices?: Array<{ value: string }> } | undefined;
    expect(typeOption?.choices?.map((choice) => choice.value)).toEqual(
      expect.arrayContaining(['quitter', 'griefer', 'dc']),
    );
  });

  it('history subcommand accepts user and nick lookup options', () => {
    const json = data.toJSON();
    const history = json.options?.find((option) => option.name === 'history');
    const optionNames = history?.options?.map((option) => option.name);

    expect(optionNames).toContain('user');
    expect(optionNames).toContain('nick');
    expect(optionNames).toContain('griefers_only');
    expect(optionNames).toContain('dcs_only');
  });

  it('cancel subcommand takes griefers and dcs slots', () => {
    const json = data.toJSON();
    const cancel = json.options?.find((option) => option.name === 'cancel');
    const optionNames = cancel?.options?.map((option) => option.name);

    expect(optionNames).toContain('griefers');
    expect(optionNames).toContain('dcs');
    expect(optionNames).not.toContain('abusers');
  });

  it('complete subcommand takes quitters, griefers, and dcs slots', () => {
    const json = data.toJSON();
    const complete = json.options?.find((option) => option.name === 'complete');
    const optionNames = complete?.options?.map((option) => option.name);

    expect(optionNames).toContain('quitters');
    expect(optionNames).toContain('griefers');
    expect(optionNames).toContain('dcs');
  });
});
