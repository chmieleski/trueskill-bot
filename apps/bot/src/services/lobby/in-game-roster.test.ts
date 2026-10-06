import { describe, expect, it } from 'vitest';
import {
  inGameRosterData,
  parseInGameRoster,
  parseInGameRosterSource,
  planSwapMoves,
  toInGameRosterSnapshot,
  type InGameRosterEntry,
  type SwapMove,
} from './in-game-roster.js';

/** Simulate the host bot: `!swap name slot` swaps name's seat with whatever is in slot. */
function applySwaps(start: Map<number, string>, moves: SwapMove[]): Map<number, string> {
  const seats = new Map(start);
  for (const move of moves) {
    const from = [...seats.entries()].find(
      ([, name]) => name.toLowerCase() === move.name.toLowerCase(),
    )?.[0];
    if (from === undefined) {
      continue; // player not in game: host bot errors, nothing moves
    }
    const occupant = seats.get(move.botSlot);
    seats.delete(from);
    if (occupant !== undefined) {
      seats.set(from, occupant);
    }
    seats.set(move.botSlot, move.name);
  }
  return seats;
}

function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

describe('toInGameRosterSnapshot / inGameRosterData', () => {
  it('normalizes nick and falls back rawName to nick', () => {
    expect(
      toInGameRosterSnapshot([
        { slot: 1, nick: 'Goku', rawName: 'Goku' },
        { slot: 7, nick: 'broly' },
      ]),
    ).toEqual([
      { slot: 1, nick: 'goku', rawName: 'Goku' },
      { slot: 7, nick: 'broly', rawName: 'broly' },
    ]);
  });

  it('builds the Match update data with source and time', () => {
    const now = new Date('2026-10-06T12:00:00Z');
    expect(inGameRosterData([{ slot: 1, nick: 'goku' }], 'wc3stats', now)).toEqual({
      inGameRoster: [{ slot: 1, nick: 'goku', rawName: 'goku' }],
      inGameRosterAt: now,
      inGameRosterSource: 'wc3stats',
    });
  });
});

describe('parseInGameRoster', () => {
  it('round-trips a valid snapshot', () => {
    const snapshot: InGameRosterEntry[] = [{ slot: 3, nick: 'goku', rawName: 'Goku' }];
    expect(parseInGameRoster(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it('returns null for null, non-arrays, and malformed entries', () => {
    expect(parseInGameRoster(null)).toBeNull();
    expect(parseInGameRoster({ slot: 1 })).toBeNull();
    expect(parseInGameRoster([{ slot: '1', nick: 'a', rawName: 'a' }])).toBeNull();
    expect(parseInGameRoster([{ slot: 1, nick: '', rawName: 'a' }])).toBeNull();
  });

  it('parses the source column', () => {
    expect(parseInGameRosterSource('screenshot')).toBe('screenshot');
    expect(parseInGameRosterSource('wc3stats')).toBe('wc3stats');
    expect(parseInGameRosterSource('other')).toBeNull();
    expect(parseInGameRosterSource(null)).toBeNull();
  });
});

describe('planSwapMoves', () => {
  it('skips players already in their target slot', () => {
    const snapshot = [
      { slot: 1, nick: 'goku', rawName: 'Goku' },
      { slot: 7, nick: 'broly', rawName: 'Broly' },
    ];
    expect(
      planSwapMoves(
        [
          { slot: 1, nick: 'goku' },
          { slot: 7, nick: 'broly' },
        ],
        snapshot,
      ),
    ).toEqual([]);
  });

  it('uses the raw in-game name and absolute target slots', () => {
    const snapshot = [
      { slot: 1, nick: 'goku', rawName: 'Goku' },
      { slot: 7, nick: 'broly', rawName: 'Broly' },
    ];
    expect(
      planSwapMoves(
        [
          { slot: 7, nick: 'goku' },
          { slot: 1, nick: 'broly' },
        ],
        snapshot,
      ),
    ).toEqual([
      { name: 'Broly', botSlot: 1 },
      { name: 'Goku', botSlot: 7 },
    ]);
  });

  it('commands a Discord-only player by username', () => {
    expect(planSwapMoves([{ slot: 2, nick: 'vegeta' }], [])).toEqual([
      { name: 'vegeta', botSlot: 2 },
    ]);
  });

  it('never commands in-game players missing from the Discord roster', () => {
    const moves = planSwapMoves(
      [{ slot: 2, nick: 'goku' }],
      [
        { slot: 1, nick: 'goku', rawName: 'Goku' },
        { slot: 2, nick: 'cell', rawName: 'Cell' },
      ],
    );
    expect(moves).toEqual([{ name: 'Goku', botSlot: 2 }]);
  });

  it('converges from any start: accurate snapshot, unknown start, extras in game', () => {
    const random = seeded(7);
    const slots = Array.from({ length: 12 }, (_, i) => i + 1);
    for (let run = 0; run < 300; run += 1) {
      const humans = Math.floor(random() * 11) + 1;
      const names = Array.from({ length: humans }, (_, i) => `P${i}`);
      const extras = random() < 0.5 ? ['Extra'] : [];
      const targetSlots = shuffled(slots, random).slice(0, humans);
      const target = names.map((name, i) => ({ slot: targetSlots[i]!, nick: name.toLowerCase() }));

      const startSlots = shuffled(slots, random);
      const start = new Map<number, string>();
      [...names, ...extras].forEach((name, i) => start.set(startSlots[i]!, name));
      const snapshot = [...start.entries()].map(([slot, name]) => ({
        slot,
        nick: name.toLowerCase(),
        rawName: name,
      }));

      for (const plan of [planSwapMoves(target, snapshot), planSwapMoves(target, [])]) {
        const end = applySwaps(start, plan);
        for (const { slot, nick } of target) {
          expect(end.get(slot)?.toLowerCase()).toBe(nick);
        }
      }
    }
  });
});
