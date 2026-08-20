import { describe, expect, it } from 'vitest';
import { resolveGrifferSlots, resolveQuitterSlots } from './match-report.js';

describe('resolveQuitterSlots', () => {
  const persistedFlags = [
    { slot: 5, isQuitter: true },
    { slot: 1, isQuitter: false },
    { slot: 9, isQuitter: true },
    { slot: 3, isQuitter: true },
  ];

  it('uses persisted quitter flags when slots are omitted', () => {
    expect(resolveQuitterSlots(persistedFlags)).toEqual([3, 5, 9]);
  });

  it('clears quitters when an explicit empty list is provided', () => {
    expect(resolveQuitterSlots(persistedFlags, [])).toEqual([]);
  });

  it('replaces persisted flags with explicit slots', () => {
    expect(resolveQuitterSlots(persistedFlags, [1])).toEqual([1]);
  });

  it('normalizes explicit slots', () => {
    expect(resolveQuitterSlots(persistedFlags, [9, 1, 9, 3])).toEqual([1, 3, 9]);
  });
});

describe('resolveGrifferSlots', () => {
  const persistedFlags = [
    { slot: 5, isGriffer: true },
    { slot: 1, isGriffer: false },
    { slot: 9, isGriffer: true },
    { slot: 3, isGriffer: true },
  ];

  it('uses persisted griffer flags when slots are omitted', () => {
    expect(resolveGrifferSlots(persistedFlags)).toEqual([3, 5, 9]);
  });

  it('clears griffers when an explicit empty list is provided', () => {
    expect(resolveGrifferSlots(persistedFlags, [])).toEqual([]);
  });
});
