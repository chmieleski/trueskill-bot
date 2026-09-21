import { describe, expect, it } from 'vitest';
import {
  classifyNewSeatsForBalance,
  computePairedNewKeys,
  entryPairKey,
  isMarkedNewPlayer,
} from './new-player-partition.js';

describe('entryPairKey', () => {
  it('combines team and slot', () => {
    expect(entryPairKey({ team: 1, slot: 3 })).toBe('1:3');
  });
});

describe('isMarkedNewPlayer', () => {
  it('is true when isNewPlayer or wasNewPlayer is set', () => {
    expect(isMarkedNewPlayer({ isNewPlayer: true })).toBe(true);
    expect(isMarkedNewPlayer({ wasNewPlayer: true })).toBe(true);
    expect(isMarkedNewPlayer({})).toBe(false);
  });
});

describe('computePairedNewKeys', () => {
  it('returns empty when k=0 (one-sided New)', () => {
    const keys = computePairedNewKeys([
      { slot: 1, team: 1, wasNewPlayer: true },
      { slot: 7, team: 2, wasNewPlayer: false },
    ]);
    expect([...keys]).toEqual([]);
  });

  it('pairs lowest slots per team for 1v1 New', () => {
    const keys = computePairedNewKeys([
      { slot: 1, team: 1, wasNewPlayer: true },
      { slot: 7, team: 2, wasNewPlayer: true },
    ]);
    expect([...keys].sort()).toEqual(['1:1', '2:7']);
  });
});

describe('classifyNewSeatsForBalance', () => {
  it('puts one-sided New in excess only when k=0', () => {
    const { frozenKeys, excessKeys } = classifyNewSeatsForBalance([
      { slot: 1, team: 1, wasNewPlayer: false },
      { slot: 7, team: 2, wasNewPlayer: true },
    ]);

    expect([...frozenKeys]).toEqual([]);
    expect([...excessKeys]).toEqual(['2:7']);
  });

  it('freezes paired New on both teams (1v1)', () => {
    const { frozenKeys, excessKeys } = classifyNewSeatsForBalance([
      { slot: 1, team: 1, isNewPlayer: true },
      { slot: 7, team: 2, isNewPlayer: true },
    ]);

    expect([...frozenKeys].sort()).toEqual(['1:1', '2:7']);
    expect([...excessKeys]).toEqual([]);
  });

  it('pairs lowest slots and marks leftover New as excess (2v1)', () => {
    const { frozenKeys, excessKeys } = classifyNewSeatsForBalance([
      { slot: 1, team: 1, isNewPlayer: true },
      { slot: 3, team: 1, isNewPlayer: true },
      { slot: 7, team: 2, isNewPlayer: true },
    ]);

    expect([...frozenKeys].sort()).toEqual(['1:1', '2:7']);
    expect([...excessKeys]).toEqual(['1:3']);
  });

  it('counts quit New toward k but only non-quit seats freeze', () => {
    const { frozenKeys, excessKeys } = classifyNewSeatsForBalance([
      { slot: 1, team: 1, wasNewPlayer: true, isQuitter: true },
      { slot: 7, team: 2, wasNewPlayer: true },
    ]);

    expect([...frozenKeys]).toEqual(['2:7']);
    expect([...excessKeys]).toEqual([]);
  });
});
