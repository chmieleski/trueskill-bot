import { MatchResult } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  buildHeroMatchesPageCustomId,
  encodeHeroMatchesHeroToken,
  formatHeroMatchField,
  parseHeroMatchesPageCustomId,
  type HeroMatchRow,
} from './hero-matches.js';
import { pickRecentHeroGames, type HeroStatsRow } from './hero-stats.js';

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

describe('encodeHeroMatchesHeroToken', () => {
  it('uses object id when present', () => {
    expect(
      encodeHeroMatchesHeroToken({ objectId: 101, nameKey: 'broly', displayName: 'Broly' }),
    ).toBe('101');
  });

  it('hashes name-only heroes to a fixed-length token', () => {
    const token = encodeHeroMatchesHeroToken({
      objectId: null,
      nameKey: 'broly',
      displayName: 'Broly',
    });
    expect(token).toMatch(/^h[0-9a-f]{8}$/);
    expect(
      encodeHeroMatchesHeroToken({
        objectId: null,
        nameKey: 'broly',
        displayName: 'Broly',
      }),
    ).toBe(token);
  });
});

describe('hero matches page custom ids', () => {
  it('round-trips prev/next and stays under 100 chars', () => {
    const playerId = 'clplayeridxxxxxxxxxxxx';
    const leagueId = 'clleagueidxxxxxxxxxxxx';
    const heroToken = '101';
    const id = buildHeroMatchesPageCustomId(playerId, leagueId, heroToken, 'next', 2);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(parseHeroMatchesPageCustomId(id)).toEqual({
      playerId,
      leagueId,
      heroToken,
      page: 3,
    });

    const prev = buildHeroMatchesPageCustomId(playerId, leagueId, heroToken, 'prev', 2);
    expect(parseHeroMatchesPageCustomId(prev)).toEqual({
      playerId,
      leagueId,
      heroToken,
      page: 1,
    });
  });

  it('stays under 100 chars for UUID player + league + snowflake', () => {
    const playerId = '1f21c92e-925a-4aef-b27f-9c4385b252fb';
    const leagueId = 'e5863052-d453-48db-b67a-14d1175c298b';
    const heroToken = encodeHeroMatchesHeroToken({
      objectId: null,
      nameKey: 'raiden ei',
      displayName: 'Raiden Ei',
    });
    const next = buildHeroMatchesPageCustomId(playerId, leagueId, heroToken, 'next', 12);
    expect(next.length).toBeLessThanOrEqual(100);
  });
});

describe('formatHeroMatchField', () => {
  it('includes outcome, date, and copyable match id', () => {
    const matchRow: HeroMatchRow = {
      matchId: 'match-abc',
      result: MatchResult.WIN,
      completedAt: new Date('2026-01-15T00:00:00Z'),
    };
    const field = formatHeroMatchField(matchRow);
    expect(field.name).toContain('✅');
    expect(field.value).toContain('match-abc');
    expect(field.value).toContain('<t:');
  });
});

describe('pickRecentHeroGames ordering', () => {
  it('newest match ids first', () => {
    const rows = [
      row({ matchId: 'm1', completedAt: new Date('2026-01-01T00:00:00Z') }),
      row({ matchId: 'm3', completedAt: new Date('2026-01-03T00:00:00Z') }),
      row({ matchId: 'm2', completedAt: new Date('2026-01-02T00:00:00Z') }),
    ];
    const recent = pickRecentHeroGames(rows, 3);
    expect(recent.map((entry) => entry.matchId)).toEqual(['m3', 'm2', 'm1']);
  });
});
