import { describe, expect, it } from 'vitest';
import { WOS_WC3STATS_SLOT_MAP } from './wc3stats-slot-map.js';
import { extractWc3statsRoster } from './wc3stats-roster.js';

describe('extractWc3statsRoster', () => {
  it('maps occupied humans to slot = index + 1', () => {
    const result = extractWc3statsRoster({
      numPlayers: 2,
      slots: [
        { status: 'occupied', player: { name: 'Alice' } },
        { status: 'open', player: null },
        { status: 'occupied', isComputer: true, player: { name: 'Comp' } },
        { status: 'occupied', player: { name: 'Bob' } },
      ],
    });
    expect(result.usable).toBe(true);
    expect(result.players).toEqual([
      { slot: 1, nick: 'alice' },
      { slot: 4, nick: 'bob' },
    ]);
  });

  it('uses a guild slot map instead of color-order index+1', () => {
    const result = extractWc3statsRoster(
      {
        numPlayers: 4,
        slots: [
          { status: 'occupied', player: { name: 'Sapphirez' } }, // 0 red → hero 1
          { status: 'occupied', player: { name: 'Wuru' } }, // 1 blue → hero 2
          { status: 'occupied', player: { name: 'Dragonnpx4' } }, // 2 teal → hero 3
          { status: 'occupied', player: { name: 'Mahson' } }, // 3 purple → hero 4
          { status: 'occupied', player: { name: 'Tiny' } }, // 4 yellow → hero 7
          { status: 'occupied', player: { name: 'notverriegod' } }, // 5 orange → hero 5
          { status: 'open', player: null }, // 6
          { status: 'occupied', player: { name: 'Sekai' } }, // 7 → hero 8
          { status: 'open', player: null },
          { status: 'open', player: null },
          { status: 'open', player: null },
          { status: 'open', player: null },
          { status: 'occupied', player: { name: 'yoMamma90' } }, // referee → skipped
        ],
      },
      {
        slotMap: new Map([
          [0, 1],
          [1, 2],
          [2, 3],
          [3, 4],
          [5, 5],
          [6, 6],
          [4, 7],
          [7, 8],
          [8, 9],
          [9, 10],
          [10, 11],
          [11, 12],
        ]),
      },
    );

    expect(result.usable).toBe(true);
    expect(result.players).toEqual([
      { slot: 1, nick: 'sapphirez' },
      { slot: 2, nick: 'wuru' },
      { slot: 3, nick: 'dragonnpx4' },
      { slot: 4, nick: 'mahson' },
      { slot: 5, nick: 'notverriegod' },
      { slot: 7, nick: 'tiny' },
      { slot: 8, nick: 'sekai' },
    ]);
  });

  it('treats empty slots with numPlayers > 0 as unusable', () => {
    const result = extractWc3statsRoster({ numPlayers: 10, slots: [] });
    expect(result.usable).toBe(false);
    expect(result.players).toEqual([]);
  });

  it('treats all-open slots with numPlayers > 0 as unusable', () => {
    const result = extractWc3statsRoster({
      numPlayers: 5,
      slots: [{ status: 'open' }, { status: 'open' }],
    });
    expect(result.usable).toBe(false);
    expect(result.players).toEqual([]);
  });

  it('allows truly empty lobbies (host only not yet observed, numPlayers 0)', () => {
    const result = extractWc3statsRoster({ numPlayers: 0, slots: [] });
    expect(result.usable).toBe(true);
    expect(result.players).toEqual([]);
  });

  it('drops later duplicate nicks instead of failing', () => {
    const result = extractWc3statsRoster({
      numPlayers: 2,
      slots: [
        { status: 'occupied', player: { name: 'Alice' } },
        { status: 'occupied', player: { name: 'alice' } },
      ],
    });
    expect(result.usable).toBe(true);
    expect(result.players).toEqual([{ slot: 1, nick: 'alice' }]);
    expect(result.occupiedCount).toBe(1);
  });

  it('maps Anime_WOS2_0.30 host in red (wc3 slot 0) to bot slot 1', () => {
    const result = extractWc3statsRoster(
      {
        numPlayers: 1,
        numSlots: 10,
        slots: [
          { status: 'occupied', player: { name: 'Chmieleski#1941' } },
          { status: 'open', player: null },
          { status: 'open', player: null },
          { status: 'open', player: null },
          { status: 'open', player: null },
          { status: 'open', player: null },
          { status: 'open', player: null },
          { status: 'open', player: null },
          { status: 'open', player: null },
          { status: 'open', player: null },
        ],
      },
      {
        slotMap: new Map(WOS_WC3STATS_SLOT_MAP.map((entry) => [entry.wc3statsSlot, entry.heroId])),
      },
    );

    expect(result.usable).toBe(true);
    expect(result.players).toEqual([{ slot: 1, nick: 'chmieleski' }]);
  });
});
