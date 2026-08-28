import { MatchResult } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  aggregateHeroWindowStats,
  filterRowsToLast10Matches,
  normalizeHeroNameKey,
  type HeroStatsRow,
} from './hero-stats.js';

function row(overrides: Partial<HeroStatsRow> & { matchId: string }): HeroStatsRow {
  return {
    playerId: 'p1',
    username: 'Alice',
    result: MatchResult.WIN,
    completedAt: new Date('2026-01-10T12:00:00Z'),
    damageTotal: 1000,
    takenTotal: 500,
    heal: 100,
    kills: 2,
    deaths: 1,
    ...overrides,
  };
}

describe('normalizeHeroNameKey', () => {
  it('lowercases and trims', () => {
    expect(normalizeHeroNameKey('  Raiden Ei ')).toBe('raiden ei');
  });
});

describe('filterRowsToLast10Matches', () => {
  it('keeps only rows from the 10 newest match ids', () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      row({
        matchId: `m${index}`,
        completedAt: new Date(`2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`),
      }),
    );
    const filtered = filterRowsToLast10Matches(rows);
    const matchIds = new Set(filtered.map((entry) => entry.matchId));
    expect(matchIds.size).toBe(10);
    expect(matchIds.has('m11')).toBe(true);
    expect(matchIds.has('m0')).toBe(false);
  });
});

describe('aggregateHeroWindowStats', () => {
  it('computes averages and KDA as sum(kills)/sum(deaths)', () => {
    const stats = aggregateHeroWindowStats(
      [
        row({ matchId: 'm1', kills: 4, deaths: 1, damageTotal: 1000 }),
        row({ matchId: 'm2', kills: 2, deaths: 1, damageTotal: 2000 }),
      ],
      { includeTopPlayers: false },
    );
    expect(stats.games).toBe(2);
    expect(stats.avgDamage).toBe(1500);
    expect(stats.kda).toBe('3');
  });

  it('shows em dash KDA when no deaths', () => {
    const stats = aggregateHeroWindowStats([row({ matchId: 'm1', kills: 5, deaths: 0 })], {
      includeTopPlayers: false,
    });
    expect(stats.kda).toBe('—');
  });

  it('returns top players with min 3 games sorted by WR', () => {
    const mk = (playerId: string, username: string, wins: number, losses: number) =>
      Array.from({ length: wins + losses }, (_, index) =>
        row({
          matchId: `${playerId}-${index}`,
          playerId,
          username,
          result: index < wins ? MatchResult.WIN : MatchResult.LOSS,
        }),
      );

    const rows = [...mk('a', 'Ace', 2, 1), ...mk('b', 'Bob', 4, 2), ...mk('c', 'Cara', 0, 2)];
    const stats = aggregateHeroWindowStats(rows, { includeTopPlayers: true });
    expect(stats.topPlayers.map((player) => player.username)).toEqual(['Bob', 'Ace']);
  });
});
