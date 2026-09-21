import { MatchResult } from '@dbz/db';
import { describe, expect, it } from 'vitest';
import { aggregateItemWindowStats, type ItemStatsRow } from './item-stats.js';

describe('aggregateItemWindowStats sort', () => {
  const names = new Map([
    [1, 'Alpha'],
    [2, 'Beta'],
  ]);
  const rows: ItemStatsRow[] = [
    {
      matchId: 'm1',
      result: MatchResult.WIN,
      completedAt: null,
      heroName: 'X',
      itemSlots: [1, 2, 0, 0, 0, 0],
    },
    {
      matchId: 'm2',
      result: MatchResult.LOSS,
      completedAt: null,
      heroName: 'X',
      itemSlots: [1, 0, 0, 0, 0, 0],
    },
    {
      matchId: 'm3',
      result: MatchResult.WIN,
      completedAt: null,
      heroName: 'X',
      itemSlots: [2, 0, 0, 0, 0, 0],
    },
    {
      matchId: 'm4',
      result: MatchResult.WIN,
      completedAt: null,
      heroName: 'X',
      itemSlots: [2, 0, 0, 0, 0, 0],
    },
  ];

  it('sorts by win_rate', () => {
    const entries = aggregateItemWindowStats(rows, names, 'win_rate');
    expect(entries[0]!.displayName).toBe('Beta');
  });

  it('sorts by picks', () => {
    const entries = aggregateItemWindowStats(rows, names, 'picks');
    expect(entries[0]!.displayName).toBe('Beta');
  });
});

describe('aggregateItemWindowStats', () => {
  it('computes buy rate and WR per item', () => {
    const names = new Map([[10, 'Oken']]);
    const rows: ItemStatsRow[] = [
      {
        matchId: 'm1',
        result: MatchResult.WIN,
        completedAt: null,
        heroName: 'X',
        itemSlots: [10, 0, 0, 0, 0, 0],
      },
      {
        matchId: 'm2',
        result: MatchResult.LOSS,
        completedAt: null,
        heroName: 'X',
        itemSlots: [0, 0, 0, 0, 0, 0],
      },
      {
        matchId: 'm3',
        result: MatchResult.WIN,
        completedAt: null,
        heroName: 'X',
        itemSlots: [10, 0, 0, 0, 0, 0],
      },
    ];

    const entries = aggregateItemWindowStats(rows, names);
    expect(entries[0]).toMatchObject({
      objectId: 10,
      displayName: 'Oken',
      gamesWithItem: 2,
      buyRatePercent: 66.7,
      winRatePercent: 100,
    });
  });

  it('ignores empty item slots', () => {
    const entries = aggregateItemWindowStats(
      [
        {
          matchId: 'm1',
          result: MatchResult.WIN,
          completedAt: null,
          heroName: null,
          itemSlots: [0, 0, 0, 0, 0, 0],
        },
      ],
      new Map(),
    );
    expect(entries).toHaveLength(0);
  });
});
