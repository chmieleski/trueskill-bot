import { describe, expect, it } from 'vitest';
import {
  buildHeroMenu,
  buildVoteMenu,
  buildLobbyDraftComponents,
  buildLobbyDraftEmbed,
  lobbyDraftCustomId,
  parseLobbyDraftCustomId,
} from './draft-ui.js';
import { HERO_PICK_HELP } from './draft-types.js';
import { initialLobbyDraftState } from './draft-types.js';
import { PROFILE, person, pickingState } from './test-fixtures.js';

const view = {
  profile: PROFILE,
  heroNames: new Map([
    [1, 'Goku'],
    [2, 'Vegeta'],
  ]),
};

describe('lobby draft ui', () => {
  it('round-trips custom ids, keeping colons in the arg', () => {
    const id = lobbyDraftCustomId('mrepm', 'draft1', 'some:key');
    expect(parseLobbyDraftCustomId(id)).toEqual({
      action: 'mrepm',
      draftId: 'draft1',
      arg: 'some:key',
    });
    expect(parseLobbyDraftCustomId('lobby:start')).toBeNull();
  });

  it('PICK phase shows a pool select plus manage row', () => {
    const rows = buildLobbyDraftComponents('d1', pickingState(['A', 'B', 'C', 'D']), view).map(
      (r) => r.toJSON(),
    );
    const ids = rows.flatMap((r) => r.components.map((c) => ('custom_id' in c ? c.custom_id : '')));
    expect(ids).toContain('ldraft:pick:d1');
    expect(ids).toContain('ldraft:manage:d1');
    expect(ids).toContain('ldraft:cancel:d1');
  });

  it('hero menu allows 0–2 and explains it is optional', () => {
    const menu = buildHeroMenu(
      'd1',
      [
        { id: 1, name: 'Goku' },
        { id: 2, name: 'Vegeta' },
      ],
      [2],
    );
    const select = menu.components[0]!.toJSON().components[0] as {
      min_values: number;
      max_values: number;
    };
    expect(select.min_values).toBe(0);
    expect(select.max_values).toBe(2);
    expect(menu.content).toBe(HERO_PICK_HELP);
  });

  it('vote menu pre-selects the voter ballot', () => {
    const s = {
      ...initialLobbyDraftState(
        ['A', 'B', 'C', 'D'].map((n) => person(n)),
        null,
      ),
      votes: { 'id-A': ['b'] },
    };
    const menu = buildVoteMenu('d1', s, 'id-A');
    const opts = menu.components[0]!.components[0]!.options.map((o) => [
      o.data.value,
      o.data.default,
    ]);
    expect(opts).toContainEqual(['b', true]);
    expect(opts).toContainEqual(['a', false]);
  });

  it('finished roster prefixes each player with their slot color emoji', () => {
    const state = pickingState(['A', 'B']);
    const [a, b] = state.teams!.map((t) => t.captainKey);
    const done = {
      ...state,
      heroResult: {
        [a]: { heroId: 1, how: 'wanted' as const },
        [b]: { heroId: 2, how: 'wanted' as const },
      },
    };
    const embed = buildLobbyDraftEmbed({ status: 'COMPLETE' }, done, {
      ...view,
      slotEmojis: new Map([[1, '<:w3_red:1>']]),
    }).toJSON();
    const values = embed.fields!.map((f) => f.value).join('\n');
    expect(values).toMatch(/^<:w3_red:1> 👑 .+ — Goku$/m);
    // No emoji for slot 2 → line renders without a color prefix.
    expect(values).toMatch(/^👑 .+ — Vegeta$/m);
  });

  it('finished roster is listed in slot order, not draft order', () => {
    const state = pickingState(['A', 'B', 'C', 'D']);
    const [cap, other] = state.teams!.map((t) => t.captainKey);
    const [x, y] = state.pool;
    const done = {
      ...state,
      pool: [],
      teams: [
        { ...state.teams![0], roster: [cap!, x!, y!], side: 1 as const },
        { ...state.teams![1], roster: [other!], side: 2 as const },
      ] as typeof state.teams,
      heroResult: {
        [cap!]: { heroId: 3, how: 'wanted' as const },
        [x!]: { heroId: 1, how: 'wanted' as const },
        [y!]: { heroId: 2, how: 'wanted' as const },
        [other!]: { heroId: 7, how: 'wanted' as const },
      },
    };
    const embed = buildLobbyDraftEmbed({ status: 'COMPLETE' }, done, {
      ...view,
      slotEmojis: new Map([
        [1, '<:w3_red:1>'],
        [2, '<:w3_blue:2>'],
        [3, '<:w3_teal:3>'],
      ]),
    }).toJSON();
    const lines = embed.fields![0]!.value.split('\n');
    expect(lines.map((l) => l.split(' ')[0])).toEqual([
      '<:w3_red:1>',
      '<:w3_blue:2>',
      '<:w3_teal:3>',
    ]);
  });
});
