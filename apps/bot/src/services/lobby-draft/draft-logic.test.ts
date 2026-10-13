import { describe, expect, it } from 'vitest';
import {
  applyPick,
  applySide,
  assertCanStartLobbyDraft,
  assertOnClock,
  castVote,
  applyTimeout,
  chooseCoin,
  clockChanged,
  projectedTeamSizes,
  removeParticipant,
  replaceParticipant,
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
    expect(closeVote(state, Math.random).log.join('\n')).toContain('tie broken 🎲');
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
    // Both captains' sides are spelled out in one line.
    const [a, b] = sided.teams!.map(
      (t) => sided.participants.find((p) => p.key === t.captainKey)!.nick,
    );
    expect(sided.log.at(-1)).toBe(
      `🛡️ Sides: **${a}** ➜ **${PROFILE.teamNames[2]}** · **${b}** ➜ **${PROFILE.teamNames[1]}**`,
    );
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

  it('rejects hero actions once heroes are resolved', () => {
    const s = resolveHeroPhase(heroState(), PROFILE);
    expect(() => lockInHero(s, 'id-A', PROFILE)).toThrow('That action is no longer valid.');
    expect(() => setHeroPrefs(s, 'id-A', [1], PROFILE)).toThrow('That action is no longer valid.');
    expect(() => resolveHeroPhase(s, PROFILE)).toThrow('That action is no longer valid.');
  });
});

describe('replace', () => {
  it('newcomer takes the seat as-is (pool, roster, captain)', () => {
    const s = pickingState(['A', 'B', 'C', 'D', 'E']);
    const next = replaceParticipant(s, 'c', person('Z'), PROFILE);
    expect(next.pool).toContain('z');
    expect(next.pool).not.toContain('c');
    const cap = replaceParticipant(s, 'a', person('Y'), PROFILE);
    expect(cap.teams![0]).toMatchObject({ captainKey: 'y', roster: ['y'] });
    expect(cap.log.at(-1)).toContain('**Y** replaced A');
  });

  it('refuses an unlinked replacement that leaves too few linked players before captains', () => {
    const s = initialLobbyDraftState(
      [person('A'), person('B'), person('C', false), person('D', false)],
      null,
    );
    expect(() => replaceParticipant(s, 'a', person('Z', false), PROFILE)).toThrow(
      'Need at least 2v2',
    );
  });

  it('refuses unlinked captain replacement', () => {
    expect(() =>
      replaceParticipant(pickingState(['A', 'B', 'C', 'D']), 'a', person('Z', false), PROFILE),
    ).toThrow('A captain must be linked');
  });

  it('refuses someone already in the draft', () => {
    expect(() =>
      replaceParticipant(pickingState(['A', 'B', 'C', 'D']), 'c', person('D'), PROFILE),
    ).toThrow('already in this draft');
  });

  it('drops the leaver ballot and votes for them', () => {
    const players = ['A', 'B', 'C', 'D', 'E'].map((n) => person(n));
    const s: LobbyDraftState = {
      ...initialLobbyDraftState(players, null),
      votes: { 'id-C': ['a'], 'id-A': ['c', 'b'] },
    };
    const next = replaceParticipant(s, 'c', person('Z'), PROFILE);
    expect(next.votes).toEqual({ 'id-A': ['b'] });
  });
});

describe('remove', () => {
  it('refuses when the draft could not end 2v2', () => {
    expect(() => removeParticipant(pickingState(['A', 'B', 'C', 'D']), 'c', PROFILE)).toThrow(
      'Need at least 2v2',
    );
  });

  it('captain succession: earliest-drafted linked teammate, else linked pool player', () => {
    let s = pickingState(['A', 'B', 'C', 'D', 'E', 'F']);
    s = applyPick(s, 'c'); // team 0: a, c
    const next = removeParticipant(s, 'a', PROFILE);
    expect(next.teams![0]).toMatchObject({ captainKey: 'c', roster: ['c'] });
    expect(next.participants.some((p) => p.key === 'a')).toBe(false);

    const fresh = pickingState(['A', 'B', 'C', 'D', 'E', 'F']);
    const fromPool = removeParticipant(fresh, 'a', PROFILE, () => 0);
    expect(fromPool.teams![0].roster).toHaveLength(1);
    expect(fromPool.pool).not.toContain(fromPool.teams![0].captainKey);
  });

  it('clockChanged when on-clock captain changes', () => {
    const s = pickingState(['A', 'B', 'C', 'D', 'E', 'F'], 0);
    const next = removeParticipant(s, 'a', PROFILE, () => 0);
    expect(clockChanged(s, next)).toBe(true);
    expect(clockChanged(s, removeParticipant(s, 'f', PROFILE))).toBe(false);
  });

  it('projects final sizes from remaining snake picks', () => {
    expect(projectedTeamSizes(pickingState(['A', 'B', 'C', 'D', 'E']))).toEqual([2, 3]);
  });
});

describe('applyTimeout', () => {
  it('auto-acts per phase', () => {
    const pick = applyTimeout(pickingState(['A', 'B', 'C', 'D']), PROFILE, () => 0);
    expect(pick.pickIndex).toBe(1);
    // One line per timed-out pick: who ran out, who got picked.
    expect(pick.log.at(-1)).toMatch(/^⏱️ \w+ ran out of time ➜ \*\*\w+\*\* \(random\)$/);
    expect(pick.log.filter((l) => l.includes('⏱️'))).toHaveLength(1);

    const vote = applyTimeout(
      initialLobbyDraftState(
        ['A', 'B', 'C', 'D'].map((n) => person(n)),
        null,
      ),
      PROFILE,
    );
    expect(vote.phase).toBe('COIN_CHOICE');
  });
});

describe('fix round 1', () => {
  const resolved = () => resolveHeroPhase(heroState(), PROFILE);

  it('remove/replace on a resolved draft are stale', () => {
    expect(() => removeParticipant(resolved(), 'c', PROFILE)).toThrow('no longer valid');
    expect(() => replaceParticipant(resolved(), 'c', person('Z'), PROFILE)).toThrow(
      'no longer valid',
    );
  });

  it('applyTimeout covers COIN_CHOICE, SIDE and HERO', () => {
    const coin = applyTimeout(
      { ...pickingState(['A', 'B', 'C', 'D']), phase: 'COIN_CHOICE' },
      PROFILE,
    );
    expect(coin.phase).not.toBe('COIN_CHOICE');
    expect(coin.log.some((l) => l.includes('⏱️'))).toBe(true);

    const side = applyTimeout({ ...pickingState(['A', 'B', 'C', 'D']), phase: 'SIDE' }, PROFILE);
    expect(side.teams!.every((tm) => tm.side !== null)).toBe(true);

    expect(applyTimeout(heroState(), PROFILE).heroResult).not.toBeNull();
  });

  it('replace drops hero prefs and lock-in; refuses duplicate discord id', () => {
    let s = setHeroPrefs(heroState(), 'id-C', [1], PROFILE);
    s = lockInHero(s, 'id-C', PROFILE);
    const next = replaceParticipant(s, 'c', person('Z'), PROFILE);
    expect(next.heroPrefs.c).toBeUndefined();
    expect(next.heroLockedIn).not.toContain('c');
    expect(() =>
      replaceParticipant(
        pickingState(['A', 'B', 'C', 'D']),
        'c',
        { key: 'q', nick: 'Q', discordId: 'id-D' },
        PROFILE,
      ),
    ).toThrow('already in this draft');
  });

  it('remove refusals', () => {
    const vote = initialLobbyDraftState(
      [person('A'), person('B'), person('C', false), person('D', false), person('E', false)],
      null,
    );
    expect(() => removeParticipant(vote, 'a', PROFILE)).toThrow('Need at least 2v2');

    const base = pickingState(['A', 'B', 'C', 'D']);
    const noLinked: LobbyDraftState = {
      ...base,
      participants: [
        person('A'),
        person('B'),
        person('C', false),
        person('D', false),
        person('E', false),
      ],
      pool: ['c', 'd', 'e'],
    };
    expect(() => removeParticipant(noLinked, 'a', PROFILE)).toThrow(
      'No linked player can take over as captain',
    );
  });

  it('remove: PICK moves to SIDE when the pool empties', () => {
    let s = pickingState(['A', 'B', 'C', 'D', 'E', 'F']);
    for (const k of ['c', 'd', 'e']) s = applyPick(s, k);
    expect(removeParticipant(s, 'f', PROFILE).phase).toBe('SIDE');
  });

  it('remove closes simultaneous phases early', () => {
    const players = ['A', 'B', 'C', 'D', 'E'].map((n) => person(n));
    const vote: LobbyDraftState = {
      ...initialLobbyDraftState(players, null),
      votes: { 'id-A': ['a', 'b'], 'id-B': ['a'], 'id-C': ['b'], 'id-D': ['a'] },
    };
    expect(removeParticipant(vote, 'e', PROFILE).phase).toBe('COIN_CHOICE');

    let hero = heroState();
    for (const id of ['id-A', 'id-B', 'id-D']) hero = lockInHero(hero, id, PROFILE);
    expect(removeParticipant(hero, 'c', PROFILE).heroResult).not.toBeNull();
  });

  it('projectedTeamSizes works with firstPickTeam null', () => {
    const s = { ...pickingState(['A', 'B', 'C', 'D', 'E']), firstPickTeam: null };
    expect(projectedTeamSizes(s)).toEqual([2, 3]);
  });
});
