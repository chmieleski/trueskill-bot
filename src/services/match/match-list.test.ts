import { beforeEach, describe, expect, it, vi } from 'vitest';

const { matchFindMany, matchCount, getLeagueById } = vi.hoisted(() => ({
  matchFindMany: vi.fn(),
  matchCount: vi.fn(),
  getLeagueById: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    match: {
      findMany: matchFindMany,
      count: matchCount,
    },
  },
}));

vi.mock('../league/league.js', () => ({
  getLeagueById,
}));

vi.mock('./match-service.js', () => {
  class MatchServiceError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'MatchServiceError';
    }
  }
  return { MatchServiceError };
});

import {
  buildMatchListEmbed,
  buildMatchListPageButtons,
  buildMatchListPageCustomId,
  countMatchListTeamSizes,
  formatMatchListField,
  formatMatchListFormat,
  loadMatchListPage,
  parseMatchListPageCustomId,
} from './match-list.js';
import { MatchServiceError } from './match-service.js';

describe('formatMatchListFormat', () => {
  it('prints team-1 vs team-2 counts', () => {
    expect(formatMatchListFormat(4, 6)).toBe('4v6');
    expect(formatMatchListFormat(6, 6)).toBe('6v6');
  });
});

describe('countMatchListTeamSizes', () => {
  it('counts team 1 and 2 and ignores other teams', () => {
    expect(
      countMatchListTeamSizes([
        { team: 1 },
        { team: 1 },
        { team: 1 },
        { team: 1 },
        { team: 2 },
        { team: 2 },
        { team: 2 },
        { team: 2 },
        { team: 2 },
        { team: 2 },
        { team: 3 },
      ]),
    ).toEqual({ team1: 4, team2: 6 });
  });
});

describe('formatMatchListField', () => {
  it('puts winner and format in the name; date and id in the value', () => {
    const field = formatMatchListField(
      {
        matchId: 'clxxxxxxxxxxxxxxxxxxxx',
        completedAt: new Date('2026-08-16T12:00:00.000Z'),
        winningTeam: 1,
        format: '4v6',
      },
      'Z Fighters',
    );

    expect(field.inline).toBe(false);
    expect(field.name).toBe('Z Fighters · 4v6');
    expect(field.value).toBe('<t:1786881600:D>\n`clxxxxxxxxxxxxxxxxxxxx`');
  });
});

describe('match list page custom ids', () => {
  it('round-trips prev/next and stays under 100 chars', () => {
    const invokerId = '123456789012345678';
    const leagueId = 'clleagueidxxxxxxxxxxxx';
    const next = buildMatchListPageCustomId(invokerId, leagueId, 'next', 2);
    expect(next.length).toBeLessThanOrEqual(100);
    expect(next.startsWith('ml:p:')).toBe(true);
    expect(parseMatchListPageCustomId(next)).toEqual({
      invokerId,
      leagueId,
      page: 3,
    });
    const prev = buildMatchListPageCustomId(invokerId, leagueId, 'prev', 2);
    expect(parseMatchListPageCustomId(prev)).toEqual({
      invokerId,
      leagueId,
      page: 1,
    });
  });

  it('stays under 100 chars for 19-digit snowflake + UUID league + large page', () => {
    const invokerId = '1234567890123456789';
    const leagueId = 'e5863052-d453-48db-b67a-14d1175c298b';
    const next = buildMatchListPageCustomId(invokerId, leagueId, 'next', 999999);
    const prev = buildMatchListPageCustomId(invokerId, leagueId, 'prev', 999999);
    expect(next.length).toBeLessThanOrEqual(100);
    expect(prev.length).toBeLessThanOrEqual(100);
    expect(parseMatchListPageCustomId(next)).toEqual({
      invokerId,
      leagueId,
      page: 1000000,
    });
    expect(parseMatchListPageCustomId(prev)).toEqual({
      invokerId,
      leagueId,
      page: 999998,
    });
  });

  it('does not collide with history prefix', () => {
    const id = buildMatchListPageCustomId('1', 'L1', 'next', 1);
    expect(id.startsWith('mh:')).toBe(false);
    expect(parseMatchListPageCustomId('mh:p:1:L1:n:1')).toBeNull();
  });

  it('returns null for garbage', () => {
    expect(parseMatchListPageCustomId('leaderboard:page:x')).toBeNull();
  });
});

describe('loadMatchListPage', () => {
  beforeEach(() => {
    matchFindMany.mockReset();
    matchCount.mockReset();
    getLeagueById.mockReset();
    getLeagueById.mockResolvedValue({ id: 'L1', name: 'UDBR' });
  });

  it('returns empty page 1 when no matches', async () => {
    matchCount.mockResolvedValue(0);
    matchFindMany.mockResolvedValue([]);
    const page = await loadMatchListPage({ leagueId: 'L1', page: 1 });
    expect(page.totalMatches).toBe(0);
    expect(page.totalPages).toBe(1);
    expect(page.rows).toEqual([]);
    expect(page.page).toBe(1);
    expect(page.leagueName).toBe('UDBR');
  });

  it('clamps page and maps winner plus 4v6 format', async () => {
    matchCount.mockResolvedValue(11);
    matchFindMany.mockResolvedValue([
      {
        id: 'm2',
        leagueId: 'L1',
        completedAt: new Date('2026-08-10T00:00:00.000Z'),
        createdAt: new Date('2026-08-09T00:00:00.000Z'),
        players: [
          { team: 1, result: 'LOSS' },
          { team: 1, result: 'LOSS' },
          { team: 1, result: 'LOSS' },
          { team: 1, result: 'LOSS' },
          { team: 2, result: 'WIN' },
          { team: 2, result: 'WIN' },
          { team: 2, result: 'WIN' },
          { team: 2, result: 'WIN' },
          { team: 2, result: 'WIN' },
          { team: 2, result: 'WIN' },
        ],
      },
    ]);
    const page = await loadMatchListPage({ leagueId: 'L1', page: 99 });
    expect(page.page).toBe(2);
    expect(page.totalPages).toBe(2);
    expect(page.rows).toEqual([
      {
        matchId: 'm2',
        completedAt: new Date('2026-08-10T00:00:00.000Z'),
        winningTeam: 2,
        format: '4v6',
      },
    ]);
    expect(matchFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { leagueId: 'L1', status: 'COMPLETED' },
        skip: 10,
        take: 10,
      }),
    );
  });

  it('throws when the league is missing', async () => {
    getLeagueById.mockResolvedValue(null);
    matchCount.mockResolvedValue(0);
    matchFindMany.mockResolvedValue([]);
    await expect(loadMatchListPage({ leagueId: 'missing', page: 1 })).rejects.toThrow(
      MatchServiceError,
    );
  });
});

describe('buildMatchListEmbed', () => {
  it('shows empty copy as a field', () => {
    const embed = buildMatchListEmbed(
      {
        leagueName: 'UDBR',
        page: 1,
        totalPages: 1,
        totalMatches: 0,
        rows: [],
      },
      (team) => (team === 1 ? 'Z Fighters' : 'Evil'),
    );
    expect(embed.data.author?.name).toBe('UDBR');
    expect(embed.data.title).toBe('Match list');
    expect(embed.data.description).toContain('Page **1** of **1**');
    expect(embed.data.fields?.[0]?.value).toMatch(/No completed matches yet/i);
  });

  it('adds one embed field per match', () => {
    const embed = buildMatchListEmbed(
      {
        leagueName: 'UDBR',
        page: 1,
        totalPages: 1,
        totalMatches: 1,
        rows: [
          {
            matchId: 'mid1',
            completedAt: new Date('2026-08-16T12:00:00.000Z'),
            winningTeam: 1,
            format: '6v6',
          },
        ],
      },
      (team) => (team === 1 ? 'Z Fighters' : 'Evil'),
    );
    expect(embed.data.fields).toHaveLength(1);
    expect(embed.data.fields?.[0]?.name).toBe('Z Fighters · 6v6');
    expect(embed.data.fields?.[0]?.value).toContain('`mid1`');
    expect(embed.data.footer?.text).toMatch(/match show/i);
  });
});

describe('buildMatchListPageButtons', () => {
  it('returns no row when single page', () => {
    expect(
      buildMatchListPageButtons({
        invokerId: '1',
        leagueId: 'L',
        page: 1,
        totalPages: 1,
      }),
    ).toEqual([]);
  });

  it('encodes ml:p custom ids when there are multiple pages', () => {
    const rows = buildMatchListPageButtons({
      invokerId: '123',
      leagueId: 'L1',
      page: 2,
      totalPages: 3,
    });
    expect(rows).toHaveLength(1);
    const ids = rows[0]!.toJSON().components.map((button) => button.custom_id);
    expect(ids[0]).toBe(buildMatchListPageCustomId('123', 'L1', 'prev', 2));
    expect(ids[1]).toBe(buildMatchListPageCustomId('123', 'L1', 'next', 2));
  });
});
