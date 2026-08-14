import { ApplicationCommandOptionType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { data } from './lobby.js';

describe('lobby command data', () => {
  it('requires a slot and accepts nick or user on add', () => {
    const json = data.toJSON();
    const add = json.options?.find((option) => option.name === 'add');
    const options = add && 'options' in add ? add.options ?? [] : [];

    const nick = options.find((option) => option.name === 'nick');
    const user = options.find((option) => option.name === 'user');
    const slot = options.find((option) => option.name === 'slot');

    expect(nick?.required).toBeFalsy();
    expect(user?.required).toBeFalsy();
    expect(user?.type).toBe(ApplicationCommandOptionType.User);
    expect(slot?.required).toBe(true);
  });

  it('exposes sync with optional wc3stats_id', () => {
    const json = data.toJSON();
    const sync = json.options?.find((option) => option.name === 'sync');
    const options = sync && 'options' in sync ? sync.options ?? [] : [];
    const wc3statsId = options.find((option) => option.name === 'wc3stats_id');

    expect(sync).toBeDefined();
    expect(wc3statsId?.required).toBeFalsy();
    expect(wc3statsId?.type).toBe(ApplicationCommandOptionType.Integer);
  });
});
