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
});
