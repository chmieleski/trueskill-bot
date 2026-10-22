import { describe, expect, it } from 'vitest';
import {
  lockChangesForSelection,
  lockModeOf,
  reconcileMatchPlayerLocked,
  reconcileMatchPlayerSideLocked,
} from './locked-slots.js';

describe('reconcileMatchPlayerLocked', () => {
  it('keeps lock when the same playerId stays in the same slot and incoming asks locked', () => {
    const previous = new Set(['p1:3']);
    expect(reconcileMatchPlayerLocked(previous, 'p1', 3, true)).toBe(true);
  });

  it('clears lock when the player moves to another slot', () => {
    const previous = new Set(['p1:3']);
    expect(reconcileMatchPlayerLocked(previous, 'p1', 4, true)).toBe(false);
  });

  it('clears lock when incoming lobby row is unlocked', () => {
    const previous = new Set(['p1:3']);
    expect(reconcileMatchPlayerLocked(previous, 'p1', 3, false)).toBe(false);
  });

  it('stays unlocked when OCR/wc3stats omit prior lock intent', () => {
    expect(reconcileMatchPlayerLocked(new Set(), 'p1', 3, false)).toBe(false);
  });

  it('keeps lock on a screenshot/wc3stats read when the player is still in the same slot', () => {
    const previous = new Set(['p1:3']);
    expect(reconcileMatchPlayerLocked(previous, 'p1', 3, undefined)).toBe(true);
  });

  it('clears lock on a screenshot/wc3stats read when the player changed slot', () => {
    const previous = new Set(['p1:3']);
    expect(reconcileMatchPlayerLocked(previous, 'p1', 5, undefined)).toBe(false);
  });
});

describe('reconcileMatchPlayerSideLocked', () => {
  const previous = new Map([['p1', 2]]);

  it('keeps the side lock while the player stays on the same team, any slot', () => {
    expect(reconcileMatchPlayerSideLocked(previous, 'p1', 2, undefined)).toBe(true);
    expect(reconcileMatchPlayerSideLocked(previous, 'p1', 2, true)).toBe(true);
  });

  it('clears the side lock when the player switches team', () => {
    expect(reconcileMatchPlayerSideLocked(previous, 'p1', 1, true)).toBe(false);
  });

  it('clears the side lock on an explicit unlock', () => {
    expect(reconcileMatchPlayerSideLocked(previous, 'p1', 2, false)).toBe(false);
  });

  it('never adds a side lock the player did not have', () => {
    expect(reconcileMatchPlayerSideLocked(previous, 'p2', 2, true)).toBe(false);
  });
});

describe('lockModeOf', () => {
  it('reads slot, side and none', () => {
    expect(lockModeOf({ locked: true })).toBe('slot');
    expect(lockModeOf({ sideLocked: true })).toBe('side');
    expect(lockModeOf({})).toBe('none');
    expect(lockModeOf({ locked: true, sideLocked: true })).toBe('slot');
  });
});

describe('lockChangesForSelection', () => {
  const players = [
    { slot: 1, locked: true },
    { slot: 2, sideLocked: true },
    { slot: 3 },
    { slot: 8, sideLocked: true },
  ];

  it('side selection sets side locks, clears unselected side locks, keeps slot locks', () => {
    expect(lockChangesForSelection(players, new Set([3, 8]), 'side')).toEqual([
      { slot: 1, mode: 'slot' },
      { slot: 2, mode: 'none' },
      { slot: 3, mode: 'side' },
      { slot: 8, mode: 'side' },
    ]);
  });

  it('slot selection replaces a side lock on a selected seat', () => {
    expect(lockChangesForSelection(players, new Set([2]), 'slot')).toEqual([
      { slot: 1, mode: 'none' },
      { slot: 2, mode: 'slot' },
      { slot: 3, mode: 'none' },
      { slot: 8, mode: 'side' },
    ]);
  });
});
