import { describe, expect, it } from 'vitest';
import {
  buildMatchHistoryPageCustomId,
  clampMatchHistoryPage,
  formatMatchHistoryRow,
  parseMatchHistoryPageCustomId,
  winningTeamFromPlayers,
} from './match-history.js';

describe('formatMatchHistoryRow', () => {
  it('formats summary with hero and quitter marker', () => {
    const line = formatMatchHistoryRow(
      {
        matchId: 'clxxxxxxxxxxxxxxxxxxxx',
        completedAt: new Date('2026-08-16T12:00:00.000Z'),
        result: 'WIN',
        team: 1,
        heroName: 'Goku',
        isQuitter: true,
      },
      'Z Fighters',
    );
    expect(line).toBe(
      '`clxxxxxxxxxxxxxxxxxxxx` · 2026-08-16 · W · Z Fighters · Goku Q',
    );
  });

  it('uses em dash when hero missing and omits Q when not quitter', () => {
    const line = formatMatchHistoryRow(
      {
        matchId: 'm1',
        completedAt: new Date('2026-01-02T00:00:00.000Z'),
        result: 'LOSS',
        team: 2,
        heroName: null,
        isQuitter: false,
      },
      'Evil',
    );
    expect(line).toBe('`m1` · 2026-01-02 · L · Evil · —');
  });
});

describe('clampMatchHistoryPage', () => {
  it('clamps high pages and floors below 1', () => {
    expect(clampMatchHistoryPage(99, 3)).toBe(3);
    expect(clampMatchHistoryPage(0, 3)).toBe(1);
    expect(clampMatchHistoryPage(2, 3)).toBe(2);
  });
});

describe('winningTeamFromPlayers', () => {
  it('returns team with WIN', () => {
    expect(
      winningTeamFromPlayers([
        { team: 1, result: 'LOSS' },
        { team: 2, result: 'WIN' },
      ]),
    ).toBe(2);
  });
});

describe('match history page custom ids', () => {
  it('round-trips prev/next and stays under 100 chars', () => {
    const invokerId = '123456789012345678';
    const playerId = 'clplayeridxxxxxxxxxxxx';
    const leagueId = 'clleagueidxxxxxxxxxxxx';
    const id = buildMatchHistoryPageCustomId(invokerId, playerId, leagueId, 'next', 2);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(parseMatchHistoryPageCustomId(id)).toEqual({
      invokerId,
      playerId,
      leagueId,
      page: 3,
    });
    const prev = buildMatchHistoryPageCustomId(invokerId, playerId, leagueId, 'prev', 2);
    expect(parseMatchHistoryPageCustomId(prev)).toEqual({
      invokerId,
      playerId,
      leagueId,
      page: 1,
    });
  });

  it('returns null for garbage', () => {
    expect(parseMatchHistoryPageCustomId('leaderboard:page:x')).toBeNull();
  });
});
