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

/** Lower bound, computed independently: misplaced players minus closed loops among them. */
function minimumMoves(target: { slot: number; nick: string }[], start: Map<number, string>) {
  const current = new Map([...start].map(([slot, name]) => [name.toLowerCase(), slot]));
  const targetSlot = new Map(target.map((t) => [t.nick, t.slot]));
  const occupant = new Map([...start].map(([slot, name]) => [slot, name.toLowerCase()]));
  const misplaced = target.filter((t) => current.get(t.nick) !== t.slot).map((t) => t.nick);
  const seen = new Set<string>();
  let loops = 0;
  for (const nick of misplaced) {
    if (seen.has(nick)) continue;
    let walker: string | undefined = nick;
    const path: string[] = [];
    while (walker && !seen.has(walker) && misplaced.includes(walker)) {
      seen.add(walker);
      path.push(walker);
      walker = occupant.get(targetSlot.get(walker)!);
    }
    if (walker !== undefined && path.includes(walker)) loops += 1;
  }
  return misplaced.length - loops;
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

  it('uses the raw in-game name and absolute target slots, one command for a two-player trade', () => {
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
    ).toEqual([{ name: 'Broly', botSlot: 1 }]);
  });

  it('uses k-1 commands for a loop of k players', () => {
    const snapshot = [
      { slot: 1, nick: 'a', rawName: 'A' },
      { slot: 2, nick: 'b', rawName: 'B' },
      { slot: 3, nick: 'c', rawName: 'C' },
    ];
    const target = [
      { slot: 2, nick: 'a' },
      { slot: 3, nick: 'b' },
      { slot: 1, nick: 'c' },
    ];
    expect(planSwapMoves(target, snapshot)).toHaveLength(2);
  });

  it('uses one command per player for a chain ending in an empty slot', () => {
    const snapshot = [
      { slot: 1, nick: 'a', rawName: 'A' },
      { slot: 2, nick: 'b', rawName: 'B' },
    ];
    const target = [
      { slot: 2, nick: 'a' },
      { slot: 3, nick: 'b' },
    ];
    expect(planSwapMoves(target, snapshot)).toEqual([
      { name: 'A', botSlot: 2 },
      { name: 'B', botSlot: 3 },
    ]);
  });

  it('handles two separate loops independently', () => {
    const snapshot = [
      { slot: 1, nick: 'a', rawName: 'a' },
      { slot: 7, nick: 'b', rawName: 'b' },
      { slot: 2, nick: 'c', rawName: 'c' },
      { slot: 8, nick: 'd', rawName: 'd' },
    ];
    const target = [
      { slot: 7, nick: 'a' },
      { slot: 1, nick: 'b' },
      { slot: 8, nick: 'c' },
      { slot: 2, nick: 'd' },
    ];
    expect(planSwapMoves(target, snapshot)).toHaveLength(2);
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

      const accurate = planSwapMoves(target, snapshot);
      expect(accurate.length).toBe(minimumMoves(target, start));

      for (const plan of [accurate, planSwapMoves(target, [])]) {
        const end = applySwaps(start, plan);
        for (const { slot, nick } of target) {
          expect(end.get(slot)?.toLowerCase()).toBe(nick);
        }
      }
    }
  });
});
