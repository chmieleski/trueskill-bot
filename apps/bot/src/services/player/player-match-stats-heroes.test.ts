import { MatchResult } from '@dbz/db';
import { describe, expect, it } from 'vitest';
import { RANK_HERO_TOP } from './player-profile.js';
import {
  aggregateRankHeroesFromMatchRows,
  type MatchStatsHeroRow,
} from './player-match-stats-heroes.js';

function row(
  overrides: Partial<MatchStatsHeroRow> & Pick<MatchStatsHeroRow, 'heroName' | 'result'>,
): MatchStatsHeroRow {
  return {
    heroObjectId: null,
    completedAt: new Date('2026-01-10T12:00:00Z'),
    ...overrides,
  };
}

describe('aggregateRankHeroesFromMatchRows', () => {
  it('groups by hero name and counts W/L after rank reset', () => {
    const resetAt = new Date('2026-01-01T00:00:00Z');
    const heroes = aggregateRankHeroesFromMatchRows(
      [
        row({ heroName: 'Raiden Ei', result: MatchResult.WIN }),
        row({ heroName: 'Raiden Ei', result: MatchResult.LOSS }),
        row({ heroName: 'Frieren', result: MatchResult.WIN }),
        row({
          heroName: 'Old Pick',
          result: MatchResult.WIN,
          completedAt: new Date('2025-12-01T00:00:00Z'),
        }),
      ],
      resetAt,
    );

    expect(heroes).toHaveLength(2);
    expect(heroes[0]).toMatchObject({
      name: 'Raiden Ei',
      leadingColumn: '2G',
      matchesPlayed: 2,
      wins: 1,
      losses: 1,
      winRatePercent: 50,
    });
    expect(heroes[1]).toMatchObject({
      name: 'Frieren',
      leadingColumn: '1G',
      matchesPlayed: 1,
      wins: 1,
      losses: 0,
      winRatePercent: 100,
    });
  });

  it('merges case-insensitive hero names and keeps first display casing', () => {
    const heroes = aggregateRankHeroesFromMatchRows(
      [
        row({ heroName: 'Frieren', result: MatchResult.WIN }),
        row({ heroName: 'frieren', result: MatchResult.WIN }),
      ],
      undefined,
    );

    expect(heroes).toHaveLength(1);
    expect(heroes[0]).toMatchObject({
      name: 'Frieren',
      matchesPlayed: 2,
      wins: 2,
      losses: 0,
    });
  });

  it(`returns at most ${RANK_HERO_TOP} heroes sorted by games played`, () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      row({
        heroName: `Hero ${index + 1}`,
        result: MatchResult.WIN,
        completedAt: new Date(`2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`),
      }),
    );

    const heroes = aggregateRankHeroesFromMatchRows(rows, undefined);
    expect(heroes).toHaveLength(RANK_HERO_TOP);
    expect(heroes.every((hero) => hero.leadingColumn === '1G')).toBe(true);
  });
});
