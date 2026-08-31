import { describe, expect, it } from 'vitest';
import type { DraftParticipant, DraftState } from './draft-types.js';
import { CaptainDraftError } from './draft-types.js';
import {
  addToPool,
  addToTeam,
  applyPick,
  buildTeamsFromCaptains,
  captainIndexForPick,
  currentCaptainKey,
  findParticipant,
  isDraftComplete,
  moveParticipant,
  removeFromPool,
  removeFromTeam,
  shufflePickOrder,
  swapParticipants,
  undoLastPick,
} from './draft-logic.js';

const p = (key: string, label = key): DraftParticipant => ({ key, label });

function baseState(overrides: Partial<DraftState> = {}): DraftState {
  const captains = [p('c0', 'Alice'), p('c1', 'Bob'), p('c2', 'Carol'), p('c3', 'Dave')];
  const pickOrder = [0, 1, 2, 3];
  const teams = buildTeamsFromCaptains(captains, pickOrder);
  return {
    captains,
    memberPool: [p('m0'), p('m1'), p('m2'), p('m3'), p('m4'), p('m5'), p('m6'), p('m7')],
    pickOrder,
    teams,
    pickIndex: 0,
    ...overrides,
  };
}

describe('captainIndexForPick', () => {
  it('snakes forward then reverse for 4 captains', () => {
    const n = 4;
    expect(captainIndexForPick(0, n)).toBe(0);
    expect(captainIndexForPick(3, n)).toBe(3);
    expect(captainIndexForPick(4, n)).toBe(3);
    expect(captainIndexForPick(7, n)).toBe(0);
    expect(captainIndexForPick(8, n)).toBe(0);
  });
});

describe('shufflePickOrder', () => {
  it('is deterministic with injected rng', () => {
    const rng = () => 0;
    expect(shufflePickOrder(3, rng)).toEqual([0, 2, 1]);
  });

  it('returns identity order for count 0 and 1', () => {
    expect(shufflePickOrder(0)).toEqual([]);
    expect(shufflePickOrder(1)).toEqual([0]);
  });
});

describe('buildTeamsFromCaptains', () => {
  it('places each captain first on their team roster', () => {
    const captains = [p('c0', 'Alice'), p('c1', 'Bob')];
    const teams = buildTeamsFromCaptains(captains, [1, 0]);
    expect(teams).toHaveLength(2);
    expect(teams[0]).toMatchObject({
      captainKey: 'c1',
      displayName: 'Team Bob',
      pickOrderIndex: 0,
      roster: [captains[1]],
    });
    expect(teams[1]).toMatchObject({
      captainKey: 'c0',
      displayName: 'Team Alice',
      pickOrderIndex: 1,
      roster: [captains[0]],
    });
  });
});

describe('applyPick', () => {
  it('removes from pool, adds to snake team, increments pickIndex', () => {
    const state = baseState();
    const next = applyPick(state, 'm0');
    expect(next.pickIndex).toBe(1);
    expect(next.memberPool.map((x) => x.key)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    expect(next.teams[0]!.roster.map((x) => x.key)).toEqual(['c0', 'm0']);
    expect(currentCaptainKey(next)).toBe('c1');
  });

  it('throws when player is not in pool', () => {
    expect(() => applyPick(baseState(), 'missing')).toThrow(CaptainDraftError);
  });
});

describe('undoLastPick', () => {
  it('reverts the last pick when pickIndex > 0', () => {
    const picked = applyPick(baseState(), 'm0');
    const undone = undoLastPick(picked);
    expect(undone.pickIndex).toBe(0);
    expect(undone.memberPool.map((x) => x.key)).toContain('m0');
    expect(undone.teams[0]!.roster.map((x) => x.key)).toEqual(['c0']);
  });

  it('throws when pickIndex is 0', () => {
    expect(() => undoLastPick(baseState())).toThrow(CaptainDraftError);
  });
});

describe('isDraftComplete', () => {
  it('is true when member pool is empty', () => {
    expect(isDraftComplete(baseState({ memberPool: [] }))).toBe(true);
    expect(isDraftComplete(baseState())).toBe(false);
  });
});

describe('pool helpers', () => {
  it('addToPool appends a player', () => {
    const state = baseState({ memberPool: [p('m0')] });
    const next = addToPool(state, p('m9'));
    expect(next.memberPool.map((x) => x.key)).toEqual(['m0', 'm9']);
  });

  it('removeFromPool removes by key', () => {
    const state = baseState();
    const next = removeFromPool(state, 'm2');
    expect(next.memberPool.map((x) => x.key)).not.toContain('m2');
  });
});

describe('team helpers', () => {
  it('addToTeam appends drafted player to target team', () => {
    const state = baseState();
    const next = addToTeam(state, 'm0', 'c1');
    expect(next.memberPool.map((x) => x.key)).not.toContain('m0');
    expect(next.teams[1]!.roster.map((x) => x.key)).toEqual(['c1', 'm0']);
  });

  it('removeFromTeam removes non-captain and returns to pool', () => {
    let state = addToTeam(baseState(), 'm0', 'c0');
    state = removeFromTeam(state, 'm0');
    expect(state.teams[0]!.roster.map((x) => x.key)).toEqual(['c0']);
    expect(state.memberPool.map((x) => x.key)).toContain('m0');
  });

  it('removeFromTeam throws for captains', () => {
    expect(() => removeFromTeam(baseState(), 'c0')).toThrow(CaptainDraftError);
  });
});

describe('swapParticipants', () => {
  it('swaps pool member with team member', () => {
    let state = addToTeam(baseState(), 'm0', 'c0');
    state = swapParticipants(state, 'm0', 'm1');
    expect(state.teams[0]!.roster.map((x) => x.key)).toEqual(['c0', 'm1']);
    expect(state.memberPool.map((x) => x.key)).toContain('m0');
    expect(state.memberPool.map((x) => x.key)).not.toContain('m1');
  });

  it('swaps two team members across teams', () => {
    let state = addToTeam(baseState(), 'm0', 'c0');
    state = addToTeam(state, 'm1', 'c1');
    state = swapParticipants(state, 'm0', 'm1');
    expect(state.teams[0]!.roster.map((x) => x.key)).toEqual(['c0', 'm1']);
    expect(state.teams[1]!.roster.map((x) => x.key)).toEqual(['c1', 'm0']);
  });

  it('throws when swapping a captain', () => {
    expect(() => swapParticipants(baseState(), 'c0', 'm0')).toThrow(CaptainDraftError);
  });
});

describe('moveParticipant', () => {
  it('moves a drafted player to another team', () => {
    let state = addToTeam(baseState(), 'm0', 'c0');
    state = moveParticipant(state, 'm0', 'c1');
    expect(state.teams[0]!.roster.map((x) => x.key)).toEqual(['c0']);
    expect(state.teams[1]!.roster.map((x) => x.key)).toEqual(['c1', 'm0']);
  });

  it('throws when player is already on target team', () => {
    let state = addToTeam(baseState(), 'm0', 'c0');
    expect(() => moveParticipant(state, 'm0', 'c0')).toThrow(CaptainDraftError);
  });

  it('throws when moving a captain', () => {
    expect(() => moveParticipant(baseState(), 'c0', 'c1')).toThrow(CaptainDraftError);
  });
});

describe('findParticipant', () => {
  it('finds participants in pool and rosters', () => {
    const state = baseState();
    expect(findParticipant(state, 'm3')?.key).toBe('m3');
    expect(findParticipant(state, 'c2')?.key).toBe('c2');
    let picked = addToTeam(state, 'm0', 'c1');
    expect(findParticipant(picked, 'm0')?.key).toBe('m0');
  });
});
