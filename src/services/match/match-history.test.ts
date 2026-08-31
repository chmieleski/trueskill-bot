import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  playerFindUnique,
  playerFindMany,
  matchFindMany,
  matchCount,
  matchRatingSnapshotFindMany,
  matchPlayerGroupBy,
  matchPlayerFindMany,
  matchPlayerStatsFindMany,
  playerRankResetFindMany,
  leagueFindUnique,
  getMatchById,
  listLeaguesForGuild,
  buildMatchCompletedEmbed,
  resolveHeroDisplayNames,
} = vi.hoisted(() => ({
  playerFindUnique: vi.fn(),
  playerFindMany: vi.fn(),
  matchFindMany: vi.fn(),
  matchCount: vi.fn(),
  matchRatingSnapshotFindMany: vi.fn(),
  matchPlayerGroupBy: vi.fn(),
  matchPlayerFindMany: vi.fn(),
  matchPlayerStatsFindMany: vi.fn(),
  playerRankResetFindMany: vi.fn(),
  leagueFindUnique: vi.fn(),
  getMatchById: vi.fn(),
  listLeaguesForGuild: vi.fn(),
  buildMatchCompletedEmbed: vi.fn(),
  resolveHeroDisplayNames: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique: leagueFindUnique },
    player: { findUnique: playerFindUnique, findMany: playerFindMany },
    match: {
      findMany: matchFindMany,
      count: matchCount,
    },
    matchRatingSnapshot: { findMany: matchRatingSnapshotFindMany },
    matchPlayer: {
      groupBy: matchPlayerGroupBy,
      findMany: matchPlayerFindMany,
      update: vi.fn(),
    },
    matchPlayerStats: { findMany: matchPlayerStatsFindMany },
    playerRankReset: { findMany: playerRankResetFindMany },
  },
}));

vi.mock('../guild/hero-catalog.js', () => ({
  loadHeroCatalog: vi.fn(async () => [{ id: 1, name: 'Goku', color: null }]),
}));

vi.mock('../game/game-hero-catalog.js', () => ({
  formatHeroDisplayName: (
    objectId: number | null | undefined,
    names: Map<number, string>,
    fallback: string | null | undefined,
  ) => {
    if (objectId != null) {
      const catalogName = names.get(objectId);
      if (catalogName) {
        return catalogName;
      }
    }
    const trimmed = fallback?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : 'Unknown hero';
  },
  resolveHeroDisplayNames,
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
    requireLeagueId: (match: { leagueId: string | null }) => {
      if (match.leagueId == null) {
        throw new MatchServiceError('This action is only available for league (IHL) matches.');
      }
      return match.leagueId;
    },
    getGameProfileForMatch: vi.fn(async () => ({})),
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
  resolveMatchHistoryHeroName,
  winningTeamFromPlayers,
} from './match-history.js';
import { CALIBRATING_LABEL } from '../rating/rating-math.js';
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

  it('uses X for cancelled matches', () => {
    expect(formatMatchHistoryResult({ result: 'CANCELLED', isQuitter: false })).toBe('X');
  });
});

describe('formatMatchHistoryField', () => {
  it('puts hero and delta in the name; outcome, team, date, id in the value', () => {
    const field = formatMatchHistoryField(
      {
        matchId: 'clxxxxxxxxxxxxxxxxxxxx',
        completedAt: new Date('2026-08-16T12:00:00.000Z'),
        result: 'WIN',
        team: 1,
        heroName: 'Goku',
        isQuitter: true,
        isGriefer: false,
        grieferKiAccrued: null,
        globalDelta: 186,
        leagueGames: 8,
      },
      'Z Fighters',
    );

    expect(field.inline).toBe(false);
    expect(field.name).toBe('Goku · ✅ +186 ki');
    expect(field.value).toBe(
      'Win · Quit · Z Fighters · <t:1786881600:D>\n`clxxxxxxxxxxxxxxxxxxxx`',
    );
  });

  it('shows em dash delta and Unknown hero when missing', () => {
    const field = formatMatchHistoryField(
      {
        matchId: 'm1',
        completedAt: new Date('2026-01-02T00:00:00.000Z'),
        result: 'LOSS',
        team: 2,
        heroName: null,
        isQuitter: false,
        isGriefer: false,
        grieferKiAccrued: null,
        leagueGames: 8,
      },
      'Evil',
    );

    expect(field.name).toBe('Unknown hero · ❌ — ki');
    expect(field.value).toContain('Loss · Evil ·');
    expect(field.value).toContain('`m1`');
  });

  it('prints Calibrating instead of a ki delta under 5 games', () => {
    const field = formatMatchHistoryField(
      {
        matchId: 'm2',
        completedAt: new Date('2026-08-16T12:00:00.000Z'),
        result: 'WIN',
        team: 1,
        heroName: 'Goku',
        isQuitter: false,
        isGriefer: false,
        grieferKiAccrued: null,
        globalDelta: 186,
        leagueGames: 3,
      },
      'Z Fighters',
    );
    expect(field.name).toBe('Goku · ✅ Calibrating');
    expect(field.name).not.toContain('186');
    expect(field.name).not.toContain(' ki');
  });

  it('formats cancelled griefer rows', () => {
    const field = formatMatchHistoryField(
      {
        matchId: 'm-cancel',
        completedAt: new Date('2026-08-16T12:00:00.000Z'),
        result: 'CANCELLED',
        team: 2,
        heroName: 'Vegeta',
        isQuitter: false,
        isGriefer: true,
        grieferKiAccrued: 80,
        leagueGames: 10,
      },
      'Evil',
    );

    expect(field.name).toBe('Vegeta · 🚫 cancelled');
    expect(field.value).toContain('Cancelled · Griefer (−80 ki pool)');
  });

  it('omits team from the value when team label is empty', () => {
    const field = formatMatchHistoryField(
      {
        matchId: 'm-wos',
        completedAt: new Date('2026-08-16T12:00:00.000Z'),
        result: 'WIN',
        team: 2,
        heroName: null,
        isQuitter: false,
        isGriefer: false,
        grieferKiAccrued: null,
        globalDelta: 12,
        leagueGames: 8,
      },
      '',
    );

    expect(field.value).toBe('Win · <t:1786881600:D>\n`m-wos`');
    expect(field.value).not.toContain('WOS');
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
      griefersOnly: false,
    });
    const prev = buildMatchHistoryPageCustomId(invokerId, playerId, leagueId, 'prev', 2);
    expect(parseMatchHistoryPageCustomId(prev)).toEqual({
      invokerId,
      playerId,
      leagueId,
      page: 1,
      griefersOnly: false,
    });
  });

  it('round-trips griefers-only pagination', () => {
    const invokerId = '123456789012345678';
    const playerId = 'clplayeridxxxxxxxxxxxx';
    const leagueId = 'clleagueidxxxxxxxxxxxx';
    const id = buildMatchHistoryPageCustomId(invokerId, playerId, leagueId, 'next', 1, true);
    expect(id.endsWith(':g')).toBe(true);
    expect(parseMatchHistoryPageCustomId(id)).toEqual({
      invokerId,
      playerId,
      leagueId,
      page: 2,
      griefersOnly: true,
    });
  });

  it('stays under 100 chars for UUID player + UUID league + snowflake', () => {
    const invokerId = '1234567890123456789';
    const playerId = '1f21c92e-925a-4aef-b27f-9c4385b252fb';
    const leagueId = 'e5863052-d453-48db-b67a-14d1175c298b';
    const next = buildMatchHistoryPageCustomId(invokerId, playerId, leagueId, 'next', 12);
    const prev = buildMatchHistoryPageCustomId(invokerId, playerId, leagueId, 'prev', 12);
    expect(next.length).toBeLessThanOrEqual(100);
    expect(prev.length).toBeLessThanOrEqual(100);
    expect(parseMatchHistoryPageCustomId(next)).toEqual({
      invokerId,
      playerId,
      leagueId,
      page: 13,
      griefersOnly: false,
    });
    expect(parseMatchHistoryPageCustomId(prev)).toEqual({
      invokerId,
      playerId,
      leagueId,
      page: 11,
      griefersOnly: false,
    });
  });

  it('parses legacy hyphenated next/prev custom ids', () => {
    const customId =
      'mh:p:123456789012345678:1f21c92e-925a-4aef-b27f-9c4385b252fb:e5863052-d453-48db-b67a-14d1175c298b:next:1';
    expect(parseMatchHistoryPageCustomId(customId)).toEqual({
      invokerId: '123456789012345678',
      playerId: '1f21c92e-925a-4aef-b27f-9c4385b252fb',
      leagueId: 'e5863052-d453-48db-b67a-14d1175c298b',
      page: 2,
      griefersOnly: false,
    });
  });

  it('returns null for garbage', () => {
    expect(parseMatchHistoryPageCustomId('leaderboard:page:x')).toBeNull();
  });
});

describe('resolveHistoryPlayer', () => {
  beforeEach(() => {
    playerFindUnique.mockReset();
    playerFindMany.mockReset();
  });

  it('throws self link message when missing', async () => {
    playerFindUnique.mockResolvedValue(null);
    await expect(
      resolveHistoryPlayer('warcraft3_udbr', { kind: 'self', discordId: 'd1' }),
    ).rejects.toThrow(/not linked/i);
    expect(playerFindUnique).toHaveBeenCalledWith({
      where: {
        gameId_discordId: { gameId: 'warcraft3_udbr', discordId: 'd1' },
      },
    });
  });

  it('throws player not found for other user', async () => {
    playerFindUnique.mockResolvedValue(null);
    await expect(
      resolveHistoryPlayer('warcraft3_udbr', { kind: 'user', discordId: 'd2' }),
    ).rejects.toThrow('Player not found.');
  });

  it('resolves player by nick', async () => {
    playerFindUnique.mockResolvedValue({
      id: 'p-nick',
      username: 'ghost',
    });
    const player = await resolveHistoryPlayer('warcraft3_udbr', {
      kind: 'nick',
      nick: 'ghost',
    });
    expect(player).toEqual({ id: 'p-nick', username: 'ghost' });
    expect(playerFindUnique).toHaveBeenCalledWith({
      where: {
        gameId_username: { gameId: 'warcraft3_udbr', username: 'ghost' },
      },
    });
  });

  it('rejects user and nick together', async () => {
    await expect(resolveHistoryPlayer('warcraft3_udbr', { kind: 'both' })).rejects.toThrow(
      /not both/i,
    );
    expect(playerFindUnique).not.toHaveBeenCalled();
  });
});

describe('resolveMatchHistoryHeroName', () => {
  const heroNameById = new Map([[1, 'Goku']]);
  const gameHeroNames = new Map([[1211117616, 'Raiden']]);

  it('prefers uploaded stats over slot-bound catalog', () => {
    expect(
      resolveMatchHistoryHeroName(
        {
          heroId: 1,
          stats: { heroName: 'Raiden Ei', heroObjectId: 1211117616 },
        },
        heroNameById,
        gameHeroNames,
        'warcraft3_wos',
      ),
    ).toBe('Raiden');
  });

  it('falls back to Hero catalog when stats are absent', () => {
    expect(
      resolveMatchHistoryHeroName({ heroId: 1, stats: null }, heroNameById, gameHeroNames, null),
    ).toBe('Goku');
  });
});

describe('loadMatchHistoryPage', () => {
  beforeEach(() => {
    matchFindMany.mockReset();
    matchCount.mockReset();
    matchRatingSnapshotFindMany.mockReset();
    matchPlayerGroupBy.mockReset();
    matchPlayerFindMany.mockReset();
    playerRankResetFindMany.mockReset();
    leagueFindUnique.mockReset();
    resolveHeroDisplayNames.mockReset();
    matchRatingSnapshotFindMany.mockResolvedValue([]);
    matchPlayerGroupBy.mockResolvedValue([]);
    matchPlayerFindMany.mockResolvedValue([]);
    playerRankResetFindMany.mockResolvedValue([]);
    leagueFindUnique.mockResolvedValue(null);
    resolveHeroDisplayNames.mockResolvedValue(new Map());
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
    expect(page.griefersOnly).toBe(false);
  });

  it('filters to griefer matches when griefersOnly is set', async () => {
    matchCount.mockResolvedValue(0);
    matchFindMany.mockResolvedValue([]);
    await loadMatchHistoryPage({
      leagueId: 'L1',
      playerId: 'P1',
      username: 'alice',
      page: 1,
      griefersOnly: true,
    });
    expect(matchCount).toHaveBeenCalledWith({
      where: {
        leagueId: 'L1',
        status: { in: ['COMPLETED', 'CANCELLED'] },
        players: { some: { playerId: 'P1', isGriefer: true } },
      },
    });
  });

  it('maps cancelled griefer matches when griefersOnly is set', async () => {
    const endedAt = new Date('2026-08-11T00:00:00.000Z');
    matchCount.mockResolvedValue(1);
    matchFindMany.mockResolvedValue([
      {
        id: 'm-cancel',
        leagueId: 'L1',
        status: 'CANCELLED',
        completedAt: null,
        updatedAt: endedAt,
        createdAt: endedAt,
        players: [
          {
            playerId: 'P1',
            team: 2,
            result: null,
            heroId: 2,
            isQuitter: false,
            isGriefer: true,
            grieferKiAccrued: 80,
            slot: 2,
            player: { username: 'alice' },
          },
        ],
      },
    ]);

    const page = await loadMatchHistoryPage({
      leagueId: 'L1',
      playerId: 'P1',
      username: 'alice',
      page: 1,
      griefersOnly: true,
    });

    expect(page.rows).toEqual([
      expect.objectContaining({
        matchId: 'm-cancel',
        result: 'CANCELLED',
        isGriefer: true,
        grieferKiAccrued: 80,
      }),
    ]);
  });

  it('clamps page and maps rows', async () => {
    matchCount.mockResolvedValue(11);
    matchFindMany.mockResolvedValue([
      {
        id: 'm2',
        leagueId: 'L1',
        status: 'COMPLETED',
        completedAt: new Date('2026-08-10T00:00:00.000Z'),
        updatedAt: new Date('2026-08-10T00:00:00.000Z'),
        createdAt: new Date('2026-08-10T00:00:00.000Z'),
        players: [
          {
            playerId: 'P1',
            team: 1,
            result: 'WIN',
            heroId: 1,
            isQuitter: false,
            isGriefer: false,
            grieferKiAccrued: null,
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

  it('uses match stats hero name for WOS when heroId is null', async () => {
    leagueFindUnique.mockResolvedValue({ gameId: 'warcraft3_wos' });
    resolveHeroDisplayNames.mockResolvedValue(new Map([[1211117616, 'Raiden']]));
    matchCount.mockResolvedValue(1);
    matchFindMany.mockResolvedValue([
      {
        id: 'm-wos',
        leagueId: 'L-wos',
        status: 'COMPLETED',
        completedAt: new Date('2026-08-10T00:00:00.000Z'),
        updatedAt: new Date('2026-08-10T00:00:00.000Z'),
        createdAt: new Date('2026-08-10T00:00:00.000Z'),
        players: [
          {
            playerId: 'P1',
            team: 1,
            result: 'WIN',
            heroId: null,
            isQuitter: false,
            isGriefer: false,
            grieferKiAccrued: null,
            slot: 3,
            player: { username: 'alice' },
            stats: {
              heroName: 'Raiden Ei',
              heroObjectId: 1211117616,
            },
          },
        ],
      },
    ]);

    const page = await loadMatchHistoryPage({
      leagueId: 'L-wos',
      playerId: 'P1',
      username: 'alice',
      page: 1,
    });

    expect(page.rows[0]?.heroName).toBe('Raiden');
    expect(resolveHeroDisplayNames).toHaveBeenCalledWith('warcraft3_wos', [1211117616]);
  });

  it('uses post-reset game count so calibrating rows hide ki delta', async () => {
    const resetAt = new Date('2026-08-10T12:00:00.000Z');
    const matchCompletedAt = new Date('2026-08-12T12:00:00.000Z');

    matchCount.mockResolvedValue(1);
    matchFindMany.mockResolvedValue([
      {
        id: 'm-post-reset',
        leagueId: 'L1',
        status: 'COMPLETED',
        completedAt: matchCompletedAt,
        updatedAt: matchCompletedAt,
        createdAt: matchCompletedAt,
        players: [
          {
            playerId: 'P1',
            team: 1,
            result: 'WIN',
            heroId: 1,
            isQuitter: false,
            isGriefer: false,
            grieferKiAccrued: null,
            slot: 1,
            globalKiDelta: 186,
            player: { username: 'alice' },
          },
        ],
      },
    ]);
    playerRankResetFindMany.mockResolvedValue([{ playerId: 'P1', createdAt: resetAt }]);
    matchPlayerFindMany.mockResolvedValue([
      {
        playerId: 'P1',
        result: 'WIN',
        match: {
          completedAt: new Date('2026-08-01T12:00:00.000Z'),
          createdAt: new Date('2026-08-01T12:00:00.000Z'),
        },
      },
      {
        playerId: 'P1',
        result: 'LOSS',
        match: {
          completedAt: new Date('2026-08-11T12:00:00.000Z'),
          createdAt: new Date('2026-08-11T12:00:00.000Z'),
        },
      },
      {
        playerId: 'P1',
        result: 'WIN',
        match: { completedAt: matchCompletedAt, createdAt: matchCompletedAt },
      },
    ]);

    const page = await loadMatchHistoryPage({
      leagueId: 'L1',
      playerId: 'P1',
      username: 'alice',
      page: 1,
    });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.leagueGames).toBe(2);
    const field = formatMatchHistoryField(page.rows[0]!, 'Z Fighters');
    expect(field.name).toBe(`Goku · ✅ ${CALIBRATING_LABEL}`);
    expect(field.name).not.toContain('+186');
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
        griefersOnly: false,
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
            isGriefer: true,
            grieferKiAccrued: 120,
            globalDelta: 42,
            leagueGames: 8,
          },
        ],
        griefersOnly: true,
      },
      'L1',
      (t) => (t === 1 ? 'Z Fighters' : 'Evil'),
    );
    expect(embed.data.fields).toHaveLength(1);
    expect(embed.data.title).toBe('Match history · griefers');
    expect(embed.data.fields?.[0]?.name).toBe('Goku · ✅ +42 ki');
    expect(embed.data.fields?.[0]?.value).toContain('Griefer (−120 ki pool)');
    expect(embed.data.fields?.[0]?.value).toContain('`mid1`');
    expect(embed.data.fields?.[0]?.value).toContain('Win · Griefer');
    expect(embed.data.fields?.[0]?.value).toContain('Z Fighters');
  });

  it('omits team from rows when showTeam is false', () => {
    const embed = buildMatchHistoryEmbed(
      {
        targetPlayerId: 'P1',
        targetUsername: 'tiny',
        page: 1,
        totalPages: 1,
        totalMatches: 1,
        griefersOnly: false,
        rows: [
          {
            matchId: 'cmtdf28gg00013cqn26q89e4y',
            completedAt: new Date('2026-08-28T00:00:00.000Z'),
            result: 'WIN',
            team: 2,
            heroName: null,
            isQuitter: false,
            isGriefer: false,
            grieferKiAccrued: null,
            globalDelta: undefined,
            leagueGames: 3,
          },
        ],
      },
      'L1',
      (t) => (t === 1 ? 'WOS Enjoyers' : 'WOS Haters'),
      { showTeam: false },
    );
    expect(embed.data.fields?.[0]?.value).not.toContain('WOS Haters');
    expect(embed.data.fields?.[0]?.value).toContain('Win · <t:');
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
    matchPlayerFindMany.mockReset();
    matchPlayerStatsFindMany.mockReset();
    playerRankResetFindMany.mockReset();
    leagueFindUnique.mockReset();
    leagueFindUnique.mockResolvedValue(null);
    matchRatingSnapshotFindMany.mockResolvedValue([]);
    matchPlayerGroupBy.mockResolvedValue([]);
    matchPlayerFindMany.mockResolvedValue([
      {
        playerId: 'P1',
        result: 'WIN',
        isQuitter: false,
        match: { completedAt: new Date('2026-08-10T00:00:00.000Z') },
      },
      {
        playerId: 'P2',
        result: 'LOSS',
        isQuitter: false,
        match: { completedAt: new Date('2026-08-10T00:00:00.000Z') },
      },
    ]);
    playerRankResetFindMany.mockResolvedValue([]);
    matchPlayerStatsFindMany.mockResolvedValue([]);
    buildMatchCompletedEmbed.mockImplementation(() => {
      const { EmbedBuilder } = require('discord.js');
      return new EmbedBuilder().setTitle('Match Completed');
    });
  });

  it('throws not found when missing', async () => {
    getMatchById.mockResolvedValue(null);
    await expect(loadCompletedMatchShow({ matchId: 'x', guildId: 'g1' })).rejects.toThrow(
      'This match was not found.',
    );
  });

  it('throws not found when league not in guild', async () => {
    getMatchById.mockResolvedValue({
      id: 'm1',
      status: 'COMPLETED',
      leagueId: 'other',
      players: [{ team: 1, result: 'WIN' }],
    });
    listLeaguesForGuild.mockResolvedValue([{ id: 'L1' }]);
    await expect(loadCompletedMatchShow({ matchId: 'm1', guildId: 'g1' })).rejects.toThrow(
      'This match was not found.',
    );
  });

  it('throws not completed when status wrong but league ok', async () => {
    getMatchById.mockResolvedValue({
      id: 'm1',
      status: 'IN_PROGRESS',
      leagueId: 'L1',
      players: [],
    });
    listLeaguesForGuild.mockResolvedValue([{ id: 'L1' }]);
    await expect(loadCompletedMatchShow({ matchId: 'm1', guildId: 'g1' })).rejects.toThrow(
      'This match is not completed.',
    );
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

  it('returns match and embed; omits ratingPreview when snapshots and stored ki missing', async () => {
    const completedAt = new Date('2026-08-10T00:00:00.000Z');
    const match = {
      id: 'm1',
      status: 'COMPLETED',
      leagueId: 'L1',
      completedAt,
      players: [
        {
          playerId: 'P1',
          team: 1,
          result: 'WIN',
          slot: 1,
          heroId: 1,
          isQuitter: false,
          globalKi: null,
          globalKiDelta: null,
          heroKi: null,
          heroKiDelta: null,
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
    expect(embedOptions.timestamp).toBe(completedAt);
    expect(result.embed.data.title).toBe('Match Completed');
  });

  it('passes stored MatchPlayer ki as ratingPreview for all players', async () => {
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
          slot: 3,
          heroId: 3,
          isQuitter: false,
          globalKi: 4100,
          globalKiDelta: 80,
          heroKi: 4050,
          heroKiDelta: 40,
          player: { username: 'alice' },
        },
        {
          playerId: 'P2',
          team: 2,
          result: 'LOSS',
          slot: 8,
          heroId: 8,
          isQuitter: false,
          globalKi: 3900,
          globalKiDelta: -60,
          heroKi: 3880,
          heroKiDelta: -30,
          player: { username: 'bob' },
        },
      ],
    };
    getMatchById.mockResolvedValue(match);
    listLeaguesForGuild.mockResolvedValue([{ id: 'L1' }]);

    await loadCompletedMatchShow({ matchId: 'm1', guildId: 'g1' });

    const embedOptions = buildMatchCompletedEmbed.mock.calls[0]![2] as {
      ratingPreview?: { players: Array<{ slot: number; globalDelta?: number }> };
    };
    expect(embedOptions.ratingPreview?.players).toEqual([
      expect.objectContaining({
        slot: 3,
        nick: 'alice',
        globalOrdinal: 4100,
        globalDelta: 80,
        heroOrdinal: 4050,
        heroDelta: 40,
        leagueGames: 1,
      }),
      expect.objectContaining({
        slot: 8,
        nick: 'bob',
        globalOrdinal: 3900,
        globalDelta: -60,
        leagueGames: 1,
      }),
    ]);
  });

  it('falls back to createdAt when completedAt is null', async () => {
    const createdAt = new Date('2026-08-15T01:00:00.000Z');
    const match = {
      id: 'm1',
      status: 'COMPLETED',
      leagueId: 'L1',
      completedAt: null,
      createdAt,
      players: [
        {
          playerId: 'P1',
          team: 1,
          result: 'WIN',
          slot: 1,
          heroId: 1,
          isQuitter: false,
          globalKi: null,
          globalKiDelta: null,
          heroKi: null,
          heroKiDelta: null,
          player: { username: 'alice' },
        },
      ],
    };
    getMatchById.mockResolvedValue(match);
    listLeaguesForGuild.mockResolvedValue([{ id: 'L1' }]);

    await loadCompletedMatchShow({ matchId: 'm1', guildId: 'g1' });

    const embedOptions = buildMatchCompletedEmbed.mock.calls[0]![2] as Record<string, unknown>;
    expect(embedOptions.timestamp).toBe(createdAt);
  });

  it('throws MatchServiceError for tenancy failures', async () => {
    getMatchById.mockResolvedValue(null);
    await expect(loadCompletedMatchShow({ matchId: 'x', guildId: 'g1' })).rejects.toBeInstanceOf(
      MatchServiceError,
    );
  });
});
