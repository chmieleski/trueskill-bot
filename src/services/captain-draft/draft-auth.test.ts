import { describe, expect, it } from 'vitest';
import { assertCurrentCaptainPick, assertTeamCaptainRename } from './draft-auth.js';
import { buildTeamsFromCaptains } from './draft-logic.js';
import type { DraftParticipant, DraftState } from './draft-types.js';
import { CaptainDraftError } from './draft-types.js';

const p = (key: string, label = key, discordId?: string): DraftParticipant =>
  discordId ? { key, label, discordId } : { key, label };

function activeState(overrides: Partial<DraftState> = {}): DraftState {
  const captains = [p('c0', 'Alice', '111'), p('c1', 'Bob', '222')];
  const pickOrder = [0, 1];
  const teams = buildTeamsFromCaptains(captains, pickOrder);

  return {
    captains,
    memberPool: [p('m0', 'Dave'), p('m1', 'Eve')],
    pickOrder,
    teams,
    pickIndex: 0,
    ...overrides,
  };
}

describe('assertCurrentCaptainPick', () => {
  it('allows the captain whose turn it is', () => {
    expect(() => assertCurrentCaptainPick(activeState(), '111')).not.toThrow();
  });

  it('rejects a non-current captain', () => {
    expect(() => assertCurrentCaptainPick(activeState(), '222')).toThrow(CaptainDraftError);
    expect(() => assertCurrentCaptainPick(activeState(), '222')).toThrow(/Alice is on the clock/);
  });

  it('rejects when the draft is not waiting for a pick', () => {
    const state = activeState({ memberPool: [], pickIndex: 2 });

    expect(() => assertCurrentCaptainPick(state, '111')).toThrow(CaptainDraftError);
    expect(() => assertCurrentCaptainPick(state, '111')).toThrow(/not waiting for a pick/);
  });
});

describe('assertTeamCaptainRename', () => {
  it('allows the team captain to rename their team', () => {
    const state = activeState();

    expect(() => assertTeamCaptainRename(state, '111', 'c0')).not.toThrow();
  });

  it('rejects a non-captain actor', () => {
    const state = activeState();

    expect(() => assertTeamCaptainRename(state, '222', 'c0')).toThrow(CaptainDraftError);
    expect(() => assertTeamCaptainRename(state, '222', 'c0')).toThrow(/Only the team captain/);
  });
});
