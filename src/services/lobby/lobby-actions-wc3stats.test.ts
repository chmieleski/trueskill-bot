import { describe, expect, it } from 'vitest';
import { applyWc3statsRefresh } from '../wc3stats/wc3stats-roster.js';

describe('applyWc3statsRefresh', () => {
  it('replaces when incoming is usable', () => {
    const result = applyWc3statsRefresh(
      [{ slot: 1, nick: 'old' }],
      { usable: true, occupiedCount: 1, players: [{ slot: 2, nick: 'new' }] },
    );
    expect(result).toEqual({
      players: [{ slot: 2, nick: 'new' }],
      keptExisting: false,
    });
  });

  it('keeps current when incoming is unusable and current is non-empty', () => {
    const current = [{ slot: 1, nick: 'manual' }];
    const result = applyWc3statsRefresh(current, {
      usable: false,
      occupiedCount: 0,
      players: [],
    });
    expect(result).toEqual({ players: current, keptExisting: true });
  });

  it('keeps empty when both empty', () => {
    const result = applyWc3statsRefresh([], {
      usable: false,
      occupiedCount: 0,
      players: [],
    });
    expect(result).toEqual({ players: [], keptExisting: false });
  });
});
