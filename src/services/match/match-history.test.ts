import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  playerFindUnique,
  matchFindMany,
  matchCount,
  matchRatingSnapshotFindMany,
  matchPlayerGroupBy,
  getMatchById,
  listLeaguesForGuild,
  buildMatchCompletedEmbed,
} = vi.hoisted(() => ({
  playerFindUnique: vi.fn(),
  matchFindMany: vi.fn(),
  matchCount: vi.fn(),
  matchRatingSnapshotFindMany: vi.fn(),
  matchPlayerGroupBy: vi.fn(),
  getMatchById: vi.fn(),
  listLeaguesForGuild: vi.fn(),
  buildMatchCompletedEmbed: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    player: { findUnique: playerFindUnique },
    match: {
      findMany: matchFindMany,
      count: matchCount,
    },
    matchRatingSnapshot: { findMany: matchRatingSnapshotFindMany },
    matchPlayer: { groupBy: matchPlayerGroupBy },
  },
}));

vi.mock('../guild/hero-catalog.js', () => ({
  loadHeroCatalog: vi.fn(async () => [{ id: 1, name: 'Goku', color: null }]),
}));

vi.mock('../league/league-profile.js', () => ({
  getGameProfileForLeague: vi.fn(async () => ({})),
}));

vi.mock('../league/league.js', () => ({
  listLeaguesForGuild,
}));

vi.mock('../lobby/lobby-preview.js', () => ({
  buildMatchCompletedEmbed,
}));

vi.mock('./match-service.js', () => {
  class MatchServiceError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'MatchServiceError';
    }
  }

  return {
    MatchServiceError,
    getMatchById,
    matchToLobbyPlayers: (match: {
      players: Array<{ slot: number; player: { username: string } }>;
    }) =>
      match.players.map((entry) => ({
        slot: entry.slot,
        nick: entry.player.username.toLowerCase(),
      })),
  };
});

import {
  buildMatchHistoryEmbed,
  buildMatchHistoryPageButtons,
  buildMatchHistoryPageCustomId,
  clampMatchHistoryPage,
  formatMatchHistoryDelta,
  formatMatchHistoryField,
  formatMatchHistoryResult,
  loadCompletedMatchShow,
  loadMatchHistoryPage,
  parseMatchHistoryPageCustomId,
  resolveHistoryPlayer,
  winningTeamFromPlayers,
} from './match-history.js';
import { MatchServiceError } from './match-service.js';

describe('formatMatchHistoryDelta', () => {
  it('formats signed deltas and em dash when missing', () => {
    expect(formatMatchHistoryDelta(undefined)).toBe('—');
    expect(formatMatchHistoryDelta(186)).toBe('+186');
    expect(formatMatchHistoryDelta(-50)).toBe('-50');
    expect(formatMatchHistoryDelta(0)).toBe('0');
  });
});

describe('formatMatchHistoryResult', () => {
  it('marks quitters with Q', () => {
    expect(formatMatchHistoryResult({ result: 'WIN', isQuitter: true })).toBe('WQ');
    expect(formatMatchHistoryResult({ result: 'LOSS', isQuitter: false })).toBe('L');
  });
});

describe('formatMatchHistoryField', () => {
  it('builds an embed field with emoji, timestamp, hero, and copyable id', () => {
    const field = formatMatchHistoryField(
      {
        matchId: 'clxxxxxxxxxxxxxxxxxxxx',
        completedAt: new Date('2026-08-16T12:00:00.000Z'),
        result: 'WIN',
        team: 1,
        heroName: 'Goku',
        isQuitter: true,
        globalDelta: 186,
      },
      'Z Fighters',
    );

    expect(field.inline).toBe(false);
    expect(field.name).toBe('✅ Win · Quit · +186 ki');
    expect(field.value).toContain('<t:1786881600:D>');
    expect(field.value).toContain('**Goku**');
    expect(field.value).toContain('Z Fighters');
    expect(field.value).toContain('`clxxxxxxxxxxxxxxxxxxxx`');
  });

  it('omits delta when missing and uses Loss emoji', () => {
    const field = formatMatchHistoryField(
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

    expect(field.name).toBe('❌ Loss');
    expect(field.value).toContain('**Unknown hero**');
    expect(field.value).toContain('Evil');
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
    matchRatingSnapshotFindMany.mockReset();
    matchPlayerGroupBy.mockReset();
    matchRatingSnapshotFindMany.mockResolvedValue([]);
    matchPlayerGroupBy.mockResolvedValue([]);
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
        leagueId: 'L1',
        completedAt: new Date('2026-08-10T00:00:00.000Z'),
        createdAt: new Date('2026-08-10T00:00:00.000Z'),
        players: [
          {
            playerId: 'P1',
            team: 1,
            result: 'WIN',
            heroId: 1,
            isQuitter: false,
            slot: 1,
            player: { username: 'alice' },
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
      globalDelta: undefined,
    });
  });
});

describe('buildMatchHistoryEmbed', () => {
  it('shows empty copy as a field', () => {
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
    expect(embed.data.author?.name).toBe('alice');
    expect(embed.data.title).toBe('Match history');
    expect(embed.data.fields?.[0]?.value).toMatch(/No completed matches yet/i);
  });

  it('adds one embed field per match', () => {
    const embed = buildMatchHistoryEmbed(
      {
        targetPlayerId: 'P1',
        targetUsername: 'alice',
        page: 1,
        totalPages: 1,
        totalMatches: 1,
        rows: [
          {
            matchId: 'mid1',
            completedAt: new Date('2026-08-16T00:00:00.000Z'),
            result: 'WIN',
            team: 1,
            heroName: 'Goku',
            isQuitter: false,
            globalDelta: 42,
          },
        ],
      },
      'L1',
      (t) => (t === 1 ? 'Z Fighters' : 'Evil'),
    );
    expect(embed.data.fields).toHaveLength(1);
    expect(embed.data.fields?.[0]?.name).toBe('✅ Win · +42 ki');
    expect(embed.data.fields?.[0]?.value).toContain('`mid1`');
    expect(embed.data.fields?.[0]?.value).toContain('**Goku**');
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

describe('loadCompletedMatchShow', () => {
  beforeEach(() => {
    getMatchById.mockReset();
    listLeaguesForGuild.mockReset();
    buildMatchCompletedEmbed.mockReset();
    matchRatingSnapshotFindMany.mockReset();
    matchPlayerGroupBy.mockReset();
    matchRatingSnapshotFindMany.mockResolvedValue([]);
    matchPlayerGroupBy.mockResolvedValue([]);
    buildMatchCompletedEmbed.mockImplementation(() => {
      const { EmbedBuilder } = require('discord.js');
      return new EmbedBuilder().setTitle('Match Completed');
    });
  });

  it('throws not found when missing', async () => {
    getMatchById.mockResolvedValue(null);
    await expect(
      loadCompletedMatchShow({ matchId: 'x', guildId: 'g1' }),
    ).rejects.toThrow('This match was not found.');
  });

  it('throws not found when league not in guild', async () => {
    getMatchById.mockResolvedValue({
      id: 'm1',
      status: 'COMPLETED',
      leagueId: 'other',
      players: [{ team: 1, result: 'WIN' }],
    });
    listLeaguesForGuild.mockResolvedValue([{ id: 'L1' }]);
    await expect(
      loadCompletedMatchShow({ matchId: 'm1', guildId: 'g1' }),
    ).rejects.toThrow('This match was not found.');
  });

  it('throws not completed when status wrong but league ok', async () => {
    getMatchById.mockResolvedValue({
      id: 'm1',
      status: 'IN_PROGRESS',
      leagueId: 'L1',
      players: [],
    });
    listLeaguesForGuild.mockResolvedValue([{ id: 'L1' }]);
    await expect(
      loadCompletedMatchShow({ matchId: 'm1', guildId: 'g1' }),
    ).rejects.toThrow('This match is not completed.');
  });

  it('throws not found when leagueId filter mismatches', async () => {
    getMatchById.mockResolvedValue({
      id: 'm1',
      status: 'COMPLETED',
      leagueId: 'L1',
      players: [{ team: 1, result: 'WIN', slot: 1, player: { username: 'a' } }],
    });
    listLeaguesForGuild.mockResolvedValue([{ id: 'L1' }]);
    await expect(
      loadCompletedMatchShow({ matchId: 'm1', guildId: 'g1', leagueId: 'L2' }),
    ).rejects.toThrow('This match was not found.');
  });

  it('returns match and embed; omits ratingPreview when snapshots missing', async () => {
    const match = {
      id: 'm1',
      status: 'COMPLETED',
      leagueId: 'L1',
      completedAt: new Date('2026-08-10T00:00:00.000Z'),
      players: [
        {
          playerId: 'P1',
          team: 1,
          result: 'WIN',
          slot: 1,
          heroId: 1,
          isQuitter: false,
          player: { username: 'alice' },
        },
      ],
    };
    getMatchById.mockResolvedValue(match);
    listLeaguesForGuild.mockResolvedValue([{ id: 'L1' }]);

    const result = await loadCompletedMatchShow({
      matchId: 'm1',
      guildId: 'g1',
      leagueId: 'L1',
    });

    expect(result.match).toBe(match);
    expect(buildMatchCompletedEmbed).toHaveBeenCalledOnce();
    const embedOptions = buildMatchCompletedEmbed.mock.calls[0]![2] as Record<string, unknown>;
    expect(embedOptions).not.toHaveProperty('ratingPreview');
    expect(embedOptions.winningTeam).toBe(1);
    expect(result.embed.data.title).toBe('Match Completed');
  });

  it('throws MatchServiceError for tenancy failures', async () => {
    getMatchById.mockResolvedValue(null);
    await expect(
      loadCompletedMatchShow({ matchId: 'x', guildId: 'g1' }),
    ).rejects.toBeInstanceOf(MatchServiceError);
  });
});
