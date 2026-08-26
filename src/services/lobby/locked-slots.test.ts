import { describe, expect, it } from 'vitest';
import { reconcileMatchPlayerLocked } from './locked-slots.js';

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
});
