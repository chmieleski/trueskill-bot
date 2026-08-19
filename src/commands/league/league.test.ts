import { ApplicationCommandOptionType, ChannelType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID, WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';
import { data } from './league.js';

describe('league command data', () => {
  it('exposes create, list, bind, unbind, and rollover subcommands', () => {
    const json = data.toJSON();
    const names = json.options?.map((option) => option.name) ?? [];

    expect(names).toEqual(['create', 'list', 'bind', 'unbind', 'rollover']);
  });

  it('create requires UDBR game choice and name', () => {
    const json = data.toJSON();
    const create = json.options?.find((option) => option.name === 'create');
    const options = create && 'options' in create ? create.options ?? [] : [];

    const game = options.find((option) => option.name === 'game');
    const name = options.find((option) => option.name === 'name');

    expect(game?.required).toBe(true);
    expect(game?.choices?.map((choice) => ({ name: choice.name, value: choice.value }))).toEqual([
      { name: 'UDBR (Warcraft III)', value: WARCRAFT3_UDBR_GAME_ID },
      { name: 'Anime Choice Arena', value: WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID },
    ]);
    expect(name?.required).toBe(true);
    expect(name?.type).toBe(ApplicationCommandOptionType.String);
  });

  it('bind accepts channel/category target and optional league autocomplete', () => {
    const json = data.toJSON();
    const bind = json.options?.find((option) => option.name === 'bind');
    const options = bind && 'options' in bind ? bind.options ?? [] : [];

    const target = options.find((option) => option.name === 'target');
    const league = options.find((option) => option.name === 'league');

    expect(target?.required).toBe(true);
    expect(target?.type).toBe(ApplicationCommandOptionType.Channel);
    expect(target?.channel_types).toEqual(
      expect.arrayContaining([
        ChannelType.GuildText,
        ChannelType.GuildCategory,
      ]),
    );
    expect(league?.required).toBeFalsy();
    expect(league?.autocomplete).toBe(true);
  });

  it('unbind requires a channel or category target', () => {
    const json = data.toJSON();
    const unbind = json.options?.find((option) => option.name === 'unbind');
    const options = unbind && 'options' in unbind ? unbind.options ?? [] : [];

    const target = options.find((option) => option.name === 'target');

    expect(target?.required).toBe(true);
    expect(target?.type).toBe(ApplicationCommandOptionType.Channel);
    expect(target?.channel_types).toEqual(
      expect.arrayContaining([ChannelType.GuildCategory]),
    );
  });

  it('rollover requires name and reset with optional compression and league autocomplete', () => {
    const json = data.toJSON();
    const rollover = json.options?.find((option) => option.name === 'rollover');
    const options = rollover && 'options' in rollover ? rollover.options ?? [] : [];

    const name = options.find((option) => option.name === 'name');
    const reset = options.find((option) => option.name === 'reset');
    const compression = options.find((option) => option.name === 'compression');
    const league = options.find((option) => option.name === 'league');

    expect(name?.required).toBe(true);
    expect(name?.type).toBe(ApplicationCommandOptionType.String);
    expect(reset?.required).toBe(true);
    expect(reset?.choices?.map((choice) => choice.value)).toEqual(['hard', 'soft']);
    expect(compression?.required).toBeFalsy();
    expect(compression?.min_value).toBe(0);
    expect(compression?.max_value).toBe(1);
    expect(league?.required).toBeFalsy();
    expect(league?.autocomplete).toBe(true);
  });
});
