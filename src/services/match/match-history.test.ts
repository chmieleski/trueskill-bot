import { beforeEach, describe, expect, it, vi } from 'vitest';

const playerFindUnique = vi.fn();
const matchFindMany = vi.fn();
const matchCount = vi.fn();

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    player: { findUnique: (...a: unknown[]) => playerFindUnique(...a) },
    match: {
      findMany: (...a: unknown[]) => matchFindMany(...a),
      count: (...a: unknown[]) => matchCount(...a),
    },
  },
}));

vi.mock('../guild/hero-catalog.js', () => ({
  loadHeroCatalog: vi.fn(async () => [{ id: 1, name: 'Goku', color: null }]),
}));

vi.mock('../league/league-profile.js', () => ({
  getGameProfileForLeague: vi.fn(async () => ({})),
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
  buildMatchHistoryEmbed,
  buildMatchHistoryPageButtons,
  buildMatchHistoryPageCustomId,
  clampMatchHistoryPage,
  formatMatchHistoryRow,
  loadMatchHistoryPage,
  parseMatchHistoryPageCustomId,
  resolveHistoryPlayer,
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

describe('resolveHistoryPlayer', () => {
  beforeEach(() => {
    playerFindUnique.mockReset();
  });

  it('throws self link message when missing', async () => {
    playerFindUnique.mockResolvedValue(null);
    await expect(resolveHistoryPlayer('d1', 'self')).rejects.toThrow(
      /not linked/i,
    );
  });

  it('throws player not found for other user', async () => {
    playerFindUnique.mockResolvedValue(null);
    await expect(resolveHistoryPlayer('d2', 'user')).rejects.toThrow(
      'Player not found.',
    );
  });
});

describe('loadMatchHistoryPage', () => {
  beforeEach(() => {
    matchFindMany.mockReset();
    matchCount.mockReset();
  });

  it('returns empty page 1 when no matches', async () => {
    matchCount.mockResolvedValue(0);
    matchFindMany.mockResolvedValue([]);
    const page = await loadMatchHistoryPage({
      leagueId: 'L1',
      playerId: 'P1',
      username: 'alice',
      page: 1,
    });
    expect(page.totalMatches).toBe(0);
    expect(page.totalPages).toBe(1);
    expect(page.rows).toEqual([]);
    expect(page.page).toBe(1);
  });

  it('clamps page and maps rows', async () => {
    matchCount.mockResolvedValue(11);
    matchFindMany.mockResolvedValue([
      {
        id: 'm2',
        completedAt: new Date('2026-08-10T00:00:00.000Z'),
        players: [
          {
            playerId: 'P1',
            team: 1,
            result: 'WIN',
            heroId: 1,
            isQuitter: false,
          },
        ],
      },
    ]);
    const page = await loadMatchHistoryPage({
      leagueId: 'L1',
      playerId: 'P1',
      username: 'alice',
      page: 99,
    });
    expect(page.page).toBe(2);
    expect(page.totalPages).toBe(2);
    expect(page.rows[0]).toMatchObject({
      matchId: 'm2',
      result: 'WIN',
      heroName: 'Goku',
    });
  });
});

describe('buildMatchHistoryEmbed', () => {
  it('shows empty copy', () => {
    const embed = buildMatchHistoryEmbed(
      {
        targetPlayerId: 'P1',
        targetUsername: 'alice',
        page: 1,
        totalPages: 1,
        totalMatches: 0,
        rows: [],
      },
      'L1',
      (t) => (t === 1 ? 'Z Fighters' : 'Evil'),
    );
    expect(embed.data.description).toMatch(/No completed matches yet/i);
  });
});

describe('buildMatchHistoryPageButtons', () => {
  it('returns no row when single page', () => {
    expect(
      buildMatchHistoryPageButtons({
        invokerId: '1',
        playerId: 'P',
        leagueId: 'L',
        page: 1,
        totalPages: 1,
      }),
    ).toEqual([]);
  });
});
