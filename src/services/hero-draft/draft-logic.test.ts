import { describe, expect, it } from 'vitest';
import {
  applyBan,
  applyPick,
  applySkipBan,
  applyTimeout,
  availableHeroes,
  currentTurn,
  isHeroDraftComplete,
} from './draft-logic.js';
import {
  HERO_DRAFT_SEQUENCE,
  emptyHeroDraftState,
  type HeroDraftMember,
  type HeroDraftState,
  type HeroDraftTeam,
  type HeroPoolEntry,
} from './draft-types.js';

const captain = (id: string, label: string): HeroDraftMember => ({
  key: id,
  label,
  discordId: id,
});

function makePool(count: number): HeroPoolEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    objectId: i + 1,
    name: `Hero ${i + 1}`,
  }));
}

function makeTeams(): [HeroDraftTeam, HeroDraftTeam] {
  return [
    {
      side: 1,
      displayName: 'Team Alpha',
      captain: captain('c1', 'Alpha'),
      roster: [captain('c1', 'Alpha')],
      bans: [],
      picks: [],
    },
    {
      side: 2,
      displayName: 'Team Beta',
      captain: captain('c2', 'Beta'),
      roster: [captain('c2', 'Beta')],
      bans: [],
      picks: [],
    },
  ];
}

function baseState(poolSize = 20): HeroDraftState {
  return emptyHeroDraftState(makeTeams(), makePool(poolSize));
}

describe('HERO_DRAFT_SEQUENCE', () => {
  it('has 16 actions with 3 bans and 5 picks per team', () => {
    expect(HERO_DRAFT_SEQUENCE).toHaveLength(16);
    expect(HERO_DRAFT_SEQUENCE.filter((t) => t.kind === 'ban' && t.team === 1)).toHaveLength(3);
    expect(HERO_DRAFT_SEQUENCE.filter((t) => t.kind === 'ban' && t.team === 2)).toHaveLength(3);
    expect(HERO_DRAFT_SEQUENCE.filter((t) => t.kind === 'pick' && t.team === 1)).toHaveLength(5);
    expect(HERO_DRAFT_SEQUENCE.filter((t) => t.kind === 'pick' && t.team === 2)).toHaveLength(5);
  });
});

describe('applyBan / applySkipBan / applyPick', () => {
  it('starts with team 1 ban', () => {
    expect(currentTurn(baseState())).toEqual({ kind: 'ban', team: 1 });
  });

  it('records bans and advances', () => {
    const next = applyBan(baseState(), 1);
    expect(next.teams[0]!.bans).toEqual([1]);
    expect(next.turnIndex).toBe(1);
    expect(availableHeroes(next).some((h) => h.objectId === 1)).toBe(false);
  });

  it('skip ban stores null', () => {
    const next = applySkipBan(baseState());
    expect(next.teams[0]!.bans).toEqual([null]);
    expect(next.turnIndex).toBe(1);
  });

  it('rejects pick on ban turn', () => {
    expect(() => applyPick(baseState(), 1)).toThrow(/Expected a pick/);
  });

  it('completes a full draft with sequential actions', () => {
    let state = baseState();
    let heroId = 1;
    while (!isHeroDraftComplete(state)) {
      const turn = currentTurn(state)!;
      if (turn.kind === 'ban') {
        state = applyBan(state, heroId);
      } else {
        state = applyPick(state, heroId);
      }
      heroId += 1;
    }
    expect(state.teams[0]!.bans).toHaveLength(3);
    expect(state.teams[1]!.bans).toHaveLength(3);
    expect(state.teams[0]!.picks).toHaveLength(5);
    expect(state.teams[1]!.picks).toHaveLength(5);
    expect(availableHeroes(state)).toHaveLength(20 - 16);
  });
});

describe('applyTimeout', () => {
  it('skips ban on timeout', () => {
    const next = applyTimeout(baseState());
    expect(next.teams[0]!.bans).toEqual([null]);
  });

  it('picks a deterministic random hero on pick timeout', () => {
    let state = applySkipBan(baseState());
    state = applySkipBan(state);
    state = applySkipBan(state);
    state = applySkipBan(state);
    expect(currentTurn(state)).toEqual({ kind: 'pick', team: 1 });
    const next = applyTimeout(state, () => 0);
    expect(next.teams[0]!.picks).toEqual([1]);
  });
});
