import { describe, expect, it } from 'vitest';
import {
  applyPick,
  applySide,
  assertCanStartLobbyDraft,
  assertOnClock,
  castVote,
  chooseCoin,
  closeVote,
  heroIdsForSide,
  lockInHero,
  resolveHeroPhase,
  setHeroPrefs,
  onClockTeam,
  pickingTeam,
  tallyVotes,
} from './draft-logic.js';
import { initialLobbyDraftState, LobbyDraftError, type LobbyDraftState } from './draft-types.js';
import { PROFILE, person, pickingState } from './test-fixtures.js';

describe('assertCanStartLobbyDraft', () => {
  it('needs 4 players and 2 linked', () => {
    expect(() => assertCanStartLobbyDraft([person('A'), person('B'), person('C')])).toThrow(
      LobbyDraftError,
    );
    expect(() =>
      assertCanStartLobbyDraft([
        person('A'),
        person('B', false),
        person('C', false),
        person('D', false),
      ]),
    ).toThrow(LobbyDraftError);
    expect(() =>
      assertCanStartLobbyDraft([person('A'), person('B'), person('C', false), person('D', false)]),
    ).not.toThrow();
  });
});

describe('voting', () => {
  const players = [person('A'), person('B'), person('C'), person('D', false)];

  it('rejects unlinked voters and unlinked candidates', () => {
    const state = initialLobbyDraftState(players, null);
    expect(() => castVote(state, 'id-nobody', ['a'])).toThrow("You're not in this draft.");
    expect(() => castVote(state, 'id-A', ['d'])).toThrow(
      'Only linked lobby players can be captains.',
    );
    expect(() => castVote(state, 'id-A', ['a', 'b', 'c'])).toThrow(LobbyDraftError);
  });

  it('lets a voter change their vote and allows self-votes', () => {
    let state = initialLobbyDraftState(players, null);
    state = castVote(state, 'id-A', ['a']);
    state = castVote(state, 'id-A', ['b', 'c']);
    expect(state.votes['id-A']).toEqual(['b', 'c']);
    expect(state.phase).toBe('VOTE');
  });

  it('closes early when every linked player voted', () => {
    let state = initialLobbyDraftState(players, null);
    state = castVote(state, 'id-A', ['a', 'b']);
    state = castVote(state, 'id-B', ['b']);
    state = castVote(state, 'id-C', ['a']);
    expect(state.phase).toBe('COIN_CHOICE');
    expect(new Set(state.teams!.map((t) => t.captainKey))).toEqual(new Set(['a', 'b']));
    expect(new Set(state.pool)).toEqual(new Set(['c', 'd']));
  });

  it('tallies top two and ignores votes for removed players', () => {
    const state: LobbyDraftState = {
      ...initialLobbyDraftState(players, null),
      votes: { 'id-A': ['c', 'b'], 'id-B': ['c', 'ghost'], 'id-C': ['b'] },
    };
    expect(new Set(tallyVotes(state, Math.random))).toEqual(new Set(['b', 'c']));
  });

  it('marks a random tie-break with 🎲', () => {
    const state: LobbyDraftState = {
      ...initialLobbyDraftState(players, null),
      votes: { 'id-A': ['a', 'b'], 'id-B': ['c'] },
    };
    expect(closeVote(state, Math.random).log).toContain('🎲 Tie for captain broken randomly.');
  });

  it('picks random linked captains when nobody voted', () => {
    const closed = closeVote(initialLobbyDraftState(players, null), Math.random);
    const captains = closed.teams!.map((t) => t.captainKey);
    expect(captains).toHaveLength(2);
    for (const key of captains) expect(['a', 'b', 'c']).toContain(key);
  });
});

describe('coin choice', () => {
  const base = (): LobbyDraftState => ({
    ...pickingState(['A', 'B', 'C', 'D']),
    phase: 'COIN_CHOICE',
    firstPickTeam: null,
    sideChooserTeam: null,
  });

  it('FIRST_PICK: winner picks first, loser chooses side', () => {
    const next = chooseCoin(base(), 'FIRST_PICK');
    expect(next).toMatchObject({ phase: 'PICK', firstPickTeam: 0, sideChooserTeam: 1 });
  });

  it('SIDE: winner chooses side now, loser picks first', () => {
    const next = chooseCoin(base(), 'SIDE');
    expect(next).toMatchObject({ phase: 'SIDE', firstPickTeam: 1, sideChooserTeam: 0 });
    const sided = applySide(next, 2, PROFILE.teamNames);
    expect(sided.teams![0].side).toBe(2);
    expect(sided.teams![1].side).toBe(1);
    expect(sided.phase).toBe('PICK');
  });
});

describe('snake pick', () => {
  it('follows A, B, B, A and moves to SIDE when the pool empties', () => {
    let state = pickingState(['A', 'B', 'C', 'D', 'E', 'F'], 0);
    expect([0, 1, 2, 3].map((i) => pickingTeam({ ...state, pickIndex: i }))).toEqual([0, 1, 1, 0]);
    state = applyPick(state, 'c');
    state = applyPick(state, 'd');
    state = applyPick(state, 'e');
    state = applyPick(state, 'f');
    expect(state.teams![0].roster).toEqual(['a', 'c', 'f']);
    expect(state.teams![1].roster).toEqual(['b', 'd', 'e']);
    expect(state.phase).toBe('SIDE');
  });

  it('goes straight to HERO when side was chosen before picking', () => {
    let state = pickingState(['A', 'B', 'C', 'D'], 1);
    state = {
      ...state,
      teams: [
        { ...state.teams![0], side: 1 },
        { ...state.teams![1], side: 2 },
      ],
    };
    state = applyPick(applyPick(state, 'c'), 'd');
    expect(state.phase).toBe('HERO');
  });

  it('only the on-clock captain may act', () => {
    const state = pickingState(['A', 'B', 'C', 'D'], 1);
    expect(onClockTeam(state)).toBe(1);
    expect(() => assertOnClock(state, 'id-A')).toThrow("It's not your turn.");
    expect(() => assertOnClock(state, 'id-B')).not.toThrow();
  });

  it('rejects picking someone outside the pool', () => {
    expect(() => applyPick(pickingState(['A', 'B', 'C', 'D']), 'a')).toThrow('Player not in pool.');
  });
});

describe('heroIdsForSide', () => {
  it('maps UDBR sides to slots 1–6 and 7–12', () => {
    expect(heroIdsForSide(PROFILE, 1)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(heroIdsForSide(PROFILE, 2)).toEqual([7, 8, 9, 10, 11, 12]);
  });
});

function heroState(): LobbyDraftState {
  const base = pickingState(['A', 'B', 'C', 'D', 'E']);
  return {
    ...base,
    phase: 'HERO',
    participants: [...base.participants.slice(0, 4), person('E', false)],
    pool: [],
    teams: [
      { captainKey: 'a', roster: ['a', 'c', 'e'], side: 1 },
      { captainKey: 'b', roster: ['b', 'd'], side: 2 },
    ],
  };
}

describe('hero phase', () => {
  it('accepts 0–2 heroes of the player side only', () => {
    const s = heroState();
    expect(setHeroPrefs(s, 'id-A', [], PROFILE).heroPrefs.a).toEqual([]);
    expect(setHeroPrefs(s, 'id-A', [1, 2], PROFILE).heroPrefs.a).toEqual([1, 2]);
    expect(() => setHeroPrefs(s, 'id-A', [7], PROFILE)).toThrow(
      'Pick up to 2 heroes from your side.',
    );
    expect(() => setHeroPrefs(s, 'id-A', [1, 2, 3], PROFILE)).toThrow(
      'Pick up to 2 heroes from your side.',
    );
    expect(() => setHeroPrefs(s, 'id-X', [1], PROFILE)).toThrow("You're not in this draft.");
  });

  it('resolves when every linked player locked in; unlinked get random heroes', () => {
    let s = heroState();
    for (const id of ['id-A', 'id-B', 'id-C']) s = lockInHero(s, id, PROFILE);
    expect(s.heroResult).toBeNull();
    s = lockInHero(s, 'id-D', PROFILE);
    expect(s.heroResult).not.toBeNull();
    const result = s.heroResult!;
    expect(Object.keys(result).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    for (const key of ['a', 'c', 'e']) expect(result[key]!.heroId).toBeLessThanOrEqual(6);
    for (const key of ['b', 'd']) expect(result[key]!.heroId).toBeGreaterThanOrEqual(7);
    expect(result.e!.how).toBe('random');
  });

  it('resolveHeroPhase works on timeout with partial prefs', () => {
    const s = setHeroPrefs(heroState(), 'id-A', [3], PROFILE);
    expect(resolveHeroPhase(s, PROFILE).heroResult!.a).toEqual({ heroId: 3, how: 'wanted' });
  });
});
