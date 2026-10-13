import { describe, expect, it } from 'vitest';
import {
  buildHeroMenu,
  buildVoteMenu,
  buildLobbyDraftComponents,
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
});
