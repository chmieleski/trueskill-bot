import { MatchResult } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  aggregateHeroWindowStats,
  filterRowsToLast10Matches,
  filterRowsToLastNMatches,
  normalizeHeroNameKey,
  parseHeroAllStatsWindows,
  pickRecentHeroGames,
  rankAllHeroes,
  rankHeroPlayers,
  type HeroAllEntry,
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
describe('filterRowsToLastNMatches', () => {
  it('keeps only rows from the N newest match ids', () => {
    const rows = Array.from({ length: 25 }, (_, index) =>
      row({
        matchId: `m${index}`,
        completedAt: new Date(`2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`),
      }),
    );
    const filtered = filterRowsToLastNMatches(rows, 20);
    const matchIds = new Set(filtered.map((entry) => entry.matchId));
    expect(matchIds.size).toBe(20);
    expect(matchIds.has('m24')).toBe(true);
    expect(matchIds.has('m0')).toBe(false);
  });
});

describe('parseHeroAllStatsWindows', () => {
  it('defaults to both windows', () => {
    expect(parseHeroAllStatsWindows(null)).toEqual(['last20', 'overall']);
  });

  it('parses last20 only', () => {
    expect(parseHeroAllStatsWindows('last20')).toEqual(['last20']);
  });
});

describe('rankAllHeroes', () => {
  const entries: HeroAllEntry[] = [
    {
      heroDisplayName: 'Alpha',
      games: 10,
      wins: 6,
      losses: 4,
      winRatePercent: 60,
      avgDamage: 5000,
      avgTaken: 2000,
      avgHeal: 100,
    },
    {
      heroDisplayName: 'Beta',
      games: 20,
      wins: 10,
      losses: 10,
      winRatePercent: 50,
      avgDamage: 9000,
      avgTaken: 3000,
      avgHeal: 200,
    },
  ];

  it('sorts by win_rate desc', () => {
    expect(rankAllHeroes(entries, 'win_rate').map((entry) => entry.heroDisplayName)).toEqual([
      'Alpha',
      'Beta',
    ]);
  });

  it('sorts by games desc', () => {
    expect(rankAllHeroes(entries, 'games')[0]!.heroDisplayName).toBe('Beta');
  });

  it('sorts by damage desc', () => {
    expect(rankAllHeroes(entries, 'damage')[0]!.heroDisplayName).toBe('Beta');
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

describe('pickRecentHeroGames', () => {
  it('returns newest rows up to limit', () => {
    const rows = [
      row({ matchId: 'm1', completedAt: new Date('2026-01-01T00:00:00Z'), username: 'A' }),
      row({ matchId: 'm2', completedAt: new Date('2026-01-03T00:00:00Z'), username: 'B' }),
      row({ matchId: 'm3', completedAt: new Date('2026-01-02T00:00:00Z'), username: 'C' }),
    ];
    const recent = pickRecentHeroGames(rows, 2);
    expect(recent.map((entry) => entry.matchId)).toEqual(['m2', 'm3']);
  });
});

describe('rankHeroPlayers', () => {
  const mk = (playerId: string, username: string, wins: number, losses: number, damage = 1000) =>
    Array.from({ length: wins + losses }, (_, index) =>
      row({
        matchId: `${playerId}-${index}`,
        playerId,
        username,
        result: index < wins ? MatchResult.WIN : MatchResult.LOSS,
        damageTotal: damage,
        kills: 3,
        deaths: 1,
      }),
    );

  it('sorts by games desc', () => {
    const rows = [...mk('a', 'Ace', 2, 1), ...mk('b', 'Bob', 4, 2)];
    const ranked = rankHeroPlayers(rows, 'games', 10);
    expect(ranked.map((entry) => entry.username)).toEqual(['Bob', 'Ace']);
  });

  it('sorts by damage desc', () => {
    const rows = [...mk('a', 'Ace', 3, 0, 5000), ...mk('b', 'Bob', 3, 0, 9000)];
    const ranked = rankHeroPlayers(rows, 'damage', 10);
    expect(ranked[0]!.username).toBe('Bob');
  });

  it('requires min 3 games', () => {
    const rows = [...mk('a', 'Ace', 2, 0)];
    expect(rankHeroPlayers(rows, 'win_rate', 10)).toHaveLength(0);
  });
});
