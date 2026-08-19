import { describe, expect, it } from 'vitest';
import {
  buildMatchListPageCustomId,
  countMatchListTeamSizes,
  formatMatchListField,
  formatMatchListFormat,
  parseMatchListPageCustomId,
} from './match-list.js';

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
