import { describe, expect, it } from 'vitest';
import { data } from './player-new.js';

describe('player_new command data', () => {
  it('registers set and clear subcommands', () => {
    const json = data.toJSON();
    expect(json.name).toBe('player_new');
    expect(json.options?.map((option) => option.name)).toEqual(['set', 'clear']);
  });

  it('set and clear accept nick, user, and league', () => {
    const json = data.toJSON();
    for (const name of ['set', 'clear'] as const) {
      const sub = json.options?.find((option) => option.name === name);
      const optionNames = sub?.options?.map((option) => option.name) ?? [];
      expect(optionNames).toEqual(expect.arrayContaining(['nick', 'user', 'league']));
    }
  });
});
