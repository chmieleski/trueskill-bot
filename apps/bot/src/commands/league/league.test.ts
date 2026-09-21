import { ApplicationCommandOptionType, ChannelType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { WARCRAFT3_WOS_GAME_ID, WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';
import type { LeagueRolloverPreview } from '../../services/league/index.js';
import { buildRolloverPreviewMessage, data } from './league.js';

describe('league command data', () => {
  it('exposes create, list, bind, unbind, rollover, set, clear, and crunch subcommands', () => {
    const json = data.toJSON();
    const names = json.options?.map((option) => option.name) ?? [];

    expect(names).toEqual([
      'create',
      'list',
      'bind',
      'unbind',
      'rollover',
      'set',
      'clear',
      'crunch',
    ]);
  });

  it('create requires UDBR game choice and name', () => {
    const json = data.toJSON();
    const create = json.options?.find((option) => option.name === 'create');
    const options = create && 'options' in create ? (create.options ?? []) : [];

    const game = options.find((option) => option.name === 'game');
    const name = options.find((option) => option.name === 'name');

    expect(game?.required).toBe(true);
    expect(game?.choices?.map((choice) => ({ name: choice.name, value: choice.value }))).toEqual([
      { name: 'UDBR (Warcraft III)', value: WARCRAFT3_UDBR_GAME_ID },
      { name: 'WOS', value: WARCRAFT3_WOS_GAME_ID },
    ]);
    expect(name?.required).toBe(true);
    expect(name?.type).toBe(ApplicationCommandOptionType.String);
  });

  it('bind accepts channel/category target and optional league autocomplete', () => {
    const json = data.toJSON();
    const bind = json.options?.find((option) => option.name === 'bind');
    const options = bind && 'options' in bind ? (bind.options ?? []) : [];

    const target = options.find((option) => option.name === 'target');
    const league = options.find((option) => option.name === 'league');

    expect(target?.required).toBe(true);
    expect(target?.type).toBe(ApplicationCommandOptionType.Channel);
    expect(target?.channel_types).toEqual(
      expect.arrayContaining([ChannelType.GuildText, ChannelType.GuildCategory]),
    );
    expect(league?.required).toBeFalsy();
    expect(league?.autocomplete).toBe(true);
  });

  it('unbind requires a channel or category target', () => {
    const json = data.toJSON();
    const unbind = json.options?.find((option) => option.name === 'unbind');
    const options = unbind && 'options' in unbind ? (unbind.options ?? []) : [];

    const target = options.find((option) => option.name === 'target');

    expect(target?.required).toBe(true);
    expect(target?.type).toBe(ApplicationCommandOptionType.Channel);
    expect(target?.channel_types).toEqual(expect.arrayContaining([ChannelType.GuildCategory]));
  });

  it('rollover requires name and reset with optional compression and league autocomplete', () => {
    const json = data.toJSON();
    const rollover = json.options?.find((option) => option.name === 'rollover');
    const options = rollover && 'options' in rollover ? (rollover.options ?? []) : [];

    const name = options.find((option) => option.name === 'name');
    const reset = options.find((option) => option.name === 'reset');
    const compression = options.find((option) => option.name === 'compression');
    const league = options.find((option) => option.name === 'league');

    expect(name?.required).toBe(true);
    expect(name?.type).toBe(ApplicationCommandOptionType.String);
    expect(reset?.required).toBe(true);
    expect(reset?.choices?.map((choice) => ({ name: choice.name, value: choice.value }))).toEqual([
      { name: 'Continue — copy ki unchanged', value: 'continue' },
      { name: 'Soft — compress toward average', value: 'soft' },
      { name: 'Hard — everyone back to ~1000 ki', value: 'hard' },
    ]);
    expect(compression?.required).toBeFalsy();
    expect(compression?.min_value).toBe(0);
    expect(compression?.max_value).toBe(1);
    expect(league?.required).toBeFalsy();
    expect(league?.autocomplete).toBe(true);
  });
});

function previewFixture(overrides: Partial<LeagueRolloverPreview> = {}): LeagueRolloverPreview {
  return {
    draftId: 'draft-1',
    sourceLeagueId: 'src-1',
    sourceLeagueName: 'Season 1',
    successorName: 'Season 1.5',
    resetMode: 'continue',
    compression: null,
    playerCount: 12,
    bindingCount: 3,
    grieferSeasonTax: { playerCount: 0, totalKiTax: 0 },
    ...overrides,
  };
}

describe('buildRolloverPreviewMessage', () => {
  it('says continue copies ratings unchanged and freezes the old league', () => {
    const message = buildRolloverPreviewMessage(previewFixture());

    expect(message).toBe(
      [
        'Archive **Season 1** and create **Season 1.5**?',
        '• Reset: continue',
        '• Ratings copied unchanged (old league frozen)',
        '• Players seeded: 12',
        '• Bindings moved: 3',
        '',
        'This cannot be undone.',
      ].join('\n'),
    );
    expect(message).not.toMatch(/average/i);
  });

  it('includes compression for soft and omits the copied-unchanged line', () => {
    const message = buildRolloverPreviewMessage(
      previewFixture({
        successorName: 'Season 2',
        resetMode: 'soft',
        compression: 0.5,
      }),
    );

    expect(message).toBe(
      [
        'Archive **Season 1** and create **Season 2**?',
        '• Reset: soft (compression 0.5)',
        '• Players seeded: 12',
        '• Bindings moved: 3',
        '',
        'This cannot be undone.',
      ].join('\n'),
    );
    expect(message).not.toContain('copied unchanged');
  });

  it('omits compression and the copied-unchanged line for hard', () => {
    const message = buildRolloverPreviewMessage(
      previewFixture({
        successorName: 'Fresh Start',
        resetMode: 'hard',
        compression: null,
      }),
    );

    expect(message).toBe(
      [
        'Archive **Season 1** and create **Fresh Start**?',
        '• Reset: hard',
        '• Players seeded: 12',
        '• Bindings moved: 3',
        '',
        'This cannot be undone.',
      ].join('\n'),
    );
    expect(message).not.toContain('copied unchanged');
    expect(message).not.toContain('compression');
  });

  it('includes pending griefer season tax for ending season rewards', () => {
    const message = buildRolloverPreviewMessage(
      previewFixture({
        resetMode: 'continue',
        grieferSeasonTax: { playerCount: 2, totalKiTax: 450 },
      }),
    );

    expect(message).toContain(
      '• Griefer season tax: **2** player(s), **450** ki (applied to ending season ratings for rewards)',
    );
  });
});
