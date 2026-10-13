import { describe, expect, it } from 'vitest';
import { heroPickLossUpdates } from './hero-pick-losses.js';
import { initialLobbyDraftState, type LobbyDraftState } from './draft-types.js';
import { person } from './test-fixtures.js';

function drafted(): LobbyDraftState {
  const base = initialLobbyDraftState(
    ['A', 'B', 'C', 'D'].map((n) => person(n)),
    null,
  );
  const [a, b, c, d] = base.participants.map((p) => p.key);
  return {
    ...base,
    heroPrefs: { [a!]: [1], [b!]: [1, 2], [c!]: [3] },
    heroResult: {
      [a!]: { heroId: 1, how: 'contested' },
      [b!]: { heroId: 4, how: 'random' },
      [c!]: { heroId: 3, how: 'wanted' },
      [d!]: { heroId: 5, how: 'random' },
    },
  };
}

describe('heroPickLossUpdates', () => {
  it('resets on a played pick, increments on a lost clash, skips no-pick players', () => {
    const state = drafted();
    const [a, b, c, d] = state.participants.map((p) => p.key);
    const updates = heroPickLossUpdates(
      state,
      new Map([
        [a!, 1],
        [b!, 4],
        [c!, 3],
        [d!, 5],
      ]),
    );
    expect(Object.fromEntries(updates)).toEqual({
      [a!]: 'reset',
      [b!]: 'increment',
      [c!]: 'reset',
    });
  });

  it('lost the clash but swapped onto a pick before the game → reset', () => {
    const state = drafted();
    const b = state.participants[1]!.key;
    expect(heroPickLossUpdates(state, new Map([[b, 2]])).get(b)).toBe('reset');
  });

  it('got a pick in the draft but swapped away → unchanged', () => {
    const state = drafted();
    const c = state.participants[2]!.key;
    expect(heroPickLossUpdates(state, new Map([[c, 6]])).has(c)).toBe(false);
  });
});
