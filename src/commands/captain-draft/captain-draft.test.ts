import { ApplicationCommandOptionType, ApplicationCommandType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { data } from './captain-draft.js';

const EXPECTED_SUBCOMMANDS = [
  'start',
  'captains',
  'members',
  'begin',
  'pick',
  'rename',
  'rename_team',
  'publish',
  'cancel',
  'add',
  'remove',
  'swap',
  'move',
  'undo',
  'force_pick',
] as const;

describe('captain_draft command data', () => {
  it('registers as a slash command with all subcommands', () => {
    const json = data.toJSON();

    expect(json.type).toBe(ApplicationCommandType.ChatInput);
    expect(json.name).toBe('captain_draft');

    const names = (json.options ?? []).map((option) => option.name);
    expect(names).toEqual(EXPECTED_SUBCOMMANDS);
  });

  it('requires players string on captains and members', () => {
    const json = data.toJSON();

    for (const subcommandName of ['captains', 'members'] as const) {
      const subcommand = json.options?.find((option) => option.name === subcommandName);
      const options = subcommand && 'options' in subcommand ? (subcommand.options ?? []) : [];
      const players = options.find((option) => option.name === 'players');

      expect(players?.required).toBe(true);
      expect(players?.type).toBe(ApplicationCommandOptionType.String);
    }
  });

  it('exposes player autocomplete on pick and mod player actions', () => {
    const json = data.toJSON();
    const subcommandsWithPlayer = ['pick', 'add', 'remove', 'force_pick', 'move'] as const;

    for (const subcommandName of subcommandsWithPlayer) {
      const subcommand = json.options?.find((option) => option.name === subcommandName);
      const options = subcommand && 'options' in subcommand ? (subcommand.options ?? []) : [];
      const player = options.find((option) => option.name === 'player');

      expect(player?.autocomplete).toBe(true);
      expect(player?.type).toBe(ApplicationCommandOptionType.String);
    }
  });

  it('exposes swap with player_a and player_b autocomplete', () => {
    const json = data.toJSON();
    const swap = json.options?.find((option) => option.name === 'swap');
    const options = swap && 'options' in swap ? (swap.options ?? []) : [];

    const playerA = options.find((option) => option.name === 'player_a');
    const playerB = options.find((option) => option.name === 'player_b');

    expect(playerA?.autocomplete).toBe(true);
    expect(playerB?.autocomplete).toBe(true);
  });

  it('exposes team autocomplete on move, rename_team, and add', () => {
    const json = data.toJSON();

    for (const subcommandName of ['move', 'rename_team', 'add'] as const) {
      const subcommand = json.options?.find((option) => option.name === subcommandName);
      const options = subcommand && 'options' in subcommand ? (subcommand.options ?? []) : [];
      const team = options.find((option) => option.name === 'team');

      expect(team?.autocomplete).toBe(true);
      expect(team?.type).toBe(ApplicationCommandOptionType.String);
    }
  });

  it('exposes name on rename and rename_team', () => {
    const json = data.toJSON();

    for (const subcommandName of ['rename', 'rename_team'] as const) {
      const subcommand = json.options?.find((option) => option.name === subcommandName);
      const options = subcommand && 'options' in subcommand ? (subcommand.options ?? []) : [];
      const name = options.find((option) => option.name === 'name');

      expect(name?.required).toBe(true);
      expect(name?.type).toBe(ApplicationCommandOptionType.String);
    }
  });

  it('exposes optional channel on publish', () => {
    const json = data.toJSON();
    const publish = json.options?.find((option) => option.name === 'publish');
    const options = publish && 'options' in publish ? (publish.options ?? []) : [];
    const channel = options.find((option) => option.name === 'channel');

    expect(channel?.required).toBeFalsy();
    expect(channel?.type).toBe(ApplicationCommandOptionType.Channel);
  });
});
