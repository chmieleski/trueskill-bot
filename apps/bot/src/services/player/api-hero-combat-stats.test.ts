import { MatchResult, MatchStatus } from '@dbz/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiHeroStatsQuery } from '../../api/parse-query.js';
import type { HeroSelection } from '../game/game-hero-catalog.js';

const {
  matchPlayerFindMany,
  matchFindFirst,
  gameItemFindMany,
  resolveHeroSelectionMock,
  resolveHeroSelectionByObjectIdMock,
} = vi.hoisted(() => ({
  matchPlayerFindMany: vi.fn(),
  matchFindFirst: vi.fn(),
  gameItemFindMany: vi.fn(),
  resolveHeroSelectionMock: vi.fn(),
  resolveHeroSelectionByObjectIdMock: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    matchPlayer: {
      findMany: (...args: unknown[]) => matchPlayerFindMany(...args),
    },
    match: {
      findFirst: (...args: unknown[]) => matchFindFirst(...args),
    },
    gameItem: {
      findMany: (...args: unknown[]) => gameItemFindMany(...args),
    },
  },
}));

vi.mock('../game/game-hero-catalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../game/game-hero-catalog.js')>();
  return {
    ...actual,
    resolveHeroSelection: (...args: unknown[]) => resolveHeroSelectionMock(...args),
    resolveHeroSelectionByObjectId: (...args: unknown[]) =>
      resolveHeroSelectionByObjectIdMock(...args),
  };
});

import {
  aggregateApiHeroWindow,
  filterRowsToCompletedAtRange,
  itemObjectIdsFromSlots,
  loadApiHeroCombatStats,
  loadApiMatchCombatStats,
  mapItemSlots,
  mapPrismaCombatRows,
  pickRecentApiCombatGames,
  type ApiCombatRow,
  type PrismaCombatRowSource,
} from './api-hero-combat-stats.js';

function combatRow(overrides: Partial<ApiCombatRow> & { matchId: string }): ApiCombatRow {
  return {
    playerId: 'p1',
    username: 'Alice',
    result: 'WIN',
    completedAt: new Date('2026-01-10T12:00:00Z'),
    kills: 2,
    deaths: 1,
    trainDeaths: 0,
    damagePhys: 300,
    damageMagic: 700,
    damageTotal: 1000,
    takenPhys: 200,
    takenMagic: 300,
    takenTotal: 500,
    heal: 100,
    heroObjectId: null,
    heroName: null,
    itemObjectIds: [],
    ...overrides,
  };
}

function defaultQuery(overrides: Partial<ApiHeroStatsQuery> = {}): ApiHeroStatsQuery {
  return {
    scope: 'both',
    games: 20,
    from: null,
    to: null,
    recentLimit: 20,
    topPlayers: 5,
    ...overrides,
  };
}

const raidenSelection: HeroSelection = {
  objectId: 101,
  nameKey: 'raiden ei',
  displayName: 'Raiden Ei',
};

function prismaCombatSource(
  overrides: Partial<PrismaCombatRowSource> & {
    matchId: string;
    stats?: PrismaCombatRowSource['stats'];
  },
): PrismaCombatRowSource {
  return {
    playerId: 'p1',
    result: MatchResult.WIN,
    player: { username: 'Alice' },
    match: { completedAt: new Date('2026-01-10T12:00:00Z') },
    stats: {
      heroName: 'Raiden Ei',
      heroObjectId: 101,
      kills: 2,
      deaths: 1,
      trainDeaths: 0,
      damagePhys: 300,
      damageMagic: 700,
      damageTotal: 1000,
      takenPhys: 200,
      takenMagic: 300,
      takenTotal: 500,
      heal: 100,
      itemSlot1: 1,
      itemSlot2: 0,
      itemSlot3: 99,
      itemSlot4: 0,
      itemSlot5: 0,
      itemSlot6: 0,
    },
    ...overrides,
  };
}

describe('aggregateApiHeroWindow', () => {
  it('returns zeros and null win rate for empty rows', () => {
    const stats = aggregateApiHeroWindow([], 5);
    expect(stats.games).toBe(0);
    expect(stats.wins).toBe(0);
    expect(stats.losses).toBe(0);
    expect(stats.winRatePercent).toBeNull();
    expect(stats.avgDamageTotal).toBe(0);
    expect(stats.sumDamageTotal).toBe(0);
    expect(stats.kda).toBe('—');
    expect(stats.topPlayers).toEqual([]);
  });

  it('computes averages, sums, win rate, and window KDA for mixed results', () => {
    const stats = aggregateApiHeroWindow(
      [
        combatRow({
          matchId: 'm1',
          result: 'WIN',
          kills: 4,
          deaths: 2,
          trainDeaths: 1,
          damagePhys: 100,
          damageMagic: 200,
          damageTotal: 300,
          takenPhys: 50,
          takenMagic: 50,
          takenTotal: 100,
          heal: 80,
        }),
        combatRow({
          matchId: 'm2',
          result: 'LOSS',
          kills: 2,
          deaths: 4,
          trainDeaths: 3,
          damagePhys: 300,
          damageMagic: 500,
          damageTotal: 800,
          takenPhys: 150,
          takenMagic: 250,
          takenTotal: 400,
          heal: 120,
        }),
      ],
      0,
    );
    expect(stats.games).toBe(2);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);
    expect(stats.winRatePercent).toBe(50);
    expect(stats.avgDamageTotal).toBe(550);
    expect(stats.avgDamagePhys).toBe(200);
    expect(stats.avgDamageMagic).toBe(350);
    expect(stats.avgTakenTotal).toBe(250);
    expect(stats.avgHeal).toBe(100);
    expect(stats.avgKills).toBe(3);
    expect(stats.avgDeaths).toBe(3);
    expect(stats.avgTrainDeaths).toBe(2);
    expect(stats.sumDamageTotal).toBe(1100);
    expect(stats.sumKills).toBe(6);
    expect(stats.sumDeaths).toBe(6);
    expect(stats.sumTrainDeaths).toBe(4);
    expect(stats.kda).toBe('1');
    expect(stats.topPlayers).toEqual([]);
  });

  it('returns top players with min 3 games sorted by win rate', () => {
    const mk = (playerId: string, username: string, wins: number, losses: number) =>
      Array.from({ length: wins + losses }, (_, index) =>
        combatRow({
          matchId: `${playerId}-${index}`,
          playerId,
          username,
          result: index < wins ? 'WIN' : 'LOSS',
        }),
      );

    const rows = [...mk('a', 'Ace', 2, 1), ...mk('b', 'Bob', 4, 2), ...mk('c', 'Cara', 0, 2)];
    const stats = aggregateApiHeroWindow(rows, 5);
    expect(stats.topPlayers.map((player) => player.username)).toEqual(['Bob', 'Ace']);
    expect(stats.topPlayers[0]!.winRatePercent).toBeCloseTo(66.7, 1);
  });

  it('omits top players when limit is 0', () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      combatRow({ matchId: `m${index}`, playerId: 'p1' }),
    );
    const stats = aggregateApiHeroWindow(rows, 0);
    expect(stats.topPlayers).toEqual([]);
  });
});

describe('filterRowsToCompletedAtRange', () => {
  it('keeps rows with completedAt in [from, to) and drops null completedAt', () => {
    const from = new Date('2026-01-05T00:00:00Z');
    const to = new Date('2026-01-15T00:00:00Z');
    const rows = [
      combatRow({ matchId: 'in', completedAt: new Date('2026-01-10T00:00:00Z') }),
      combatRow({ matchId: 'before', completedAt: new Date('2026-01-01T00:00:00Z') }),
      combatRow({ matchId: 'at-to', completedAt: new Date('2026-01-15T00:00:00Z') }),
      combatRow({ matchId: 'null-date', completedAt: null }),
    ];
    const filtered = filterRowsToCompletedAtRange(rows, from, to);
    expect(filtered.map((row) => row.matchId)).toEqual(['in']);
  });
});

describe('mapItemSlots', () => {
  it('maps object ids to names with null when missing', () => {
    const names = new Map<number, string>([[1, 'Oken']]);
    expect(mapItemSlots([1, 99], names)).toEqual([
      { objectId: 1, name: 'Oken' },
      { objectId: 99, name: null },
    ]);
  });
});

describe('itemObjectIdsFromSlots', () => {
  it('keeps non-zero slots in order', () => {
    expect(
      itemObjectIdsFromSlots({
        itemSlot1: 1,
        itemSlot2: 0,
        itemSlot3: 3,
        itemSlot4: 0,
        itemSlot5: 5,
        itemSlot6: 0,
      }),
    ).toEqual([1, 3, 5]);
  });
});

describe('mapPrismaCombatRows', () => {
  it('maps matching WIN/LOSS rows and drops zero item slots', () => {
    const mapped = mapPrismaCombatRows(
      [
        prismaCombatSource({ matchId: 'm1' }),
        prismaCombatSource({
          matchId: 'm2',
          playerId: 'p2',
          result: MatchResult.LOSS,
          player: { username: 'Bob' },
          stats: {
            heroName: 'Frieren',
            heroObjectId: 102,
            kills: 1,
            deaths: 2,
            damagePhys: 10,
            damageMagic: 20,
            damageTotal: 30,
            takenPhys: 1,
            takenMagic: 2,
            takenTotal: 3,
            heal: 4,
            itemSlot1: 0,
            itemSlot2: 0,
            itemSlot3: 0,
            itemSlot4: 0,
            itemSlot5: 0,
            itemSlot6: 0,
          },
        }),
        prismaCombatSource({
          matchId: 'm3',
          result: MatchResult.DRAW,
        }),
        prismaCombatSource({
          matchId: 'm4',
          stats: null,
        }),
      ],
      raidenSelection,
    );

    expect(mapped).toEqual([
      {
        matchId: 'm1',
        playerId: 'p1',
        username: 'Alice',
        result: 'WIN',
        completedAt: new Date('2026-01-10T12:00:00Z'),
        kills: 2,
        deaths: 1,
        trainDeaths: 0,
        damagePhys: 300,
        damageMagic: 700,
        damageTotal: 1000,
        takenPhys: 200,
        takenMagic: 300,
        takenTotal: 500,
        heal: 100,
        heroObjectId: 101,
        heroName: 'Raiden Ei',
        itemObjectIds: [1, 99],
      },
    ]);
  });

  it('matches name-only selection when objectId is null', () => {
    const selection: HeroSelection = {
      objectId: null,
      nameKey: 'orphan',
      displayName: 'Orphan',
    };
    const mapped = mapPrismaCombatRows(
      [
        prismaCombatSource({
          matchId: 'm1',
          stats: {
            heroName: 'Orphan',
            heroObjectId: null,
            kills: 1,
            deaths: 0,
            trainDeaths: 0,
            damagePhys: 1,
            damageMagic: 1,
            damageTotal: 2,
            takenPhys: 0,
            takenMagic: 0,
            takenTotal: 0,
            heal: 0,
            itemSlot1: 0,
            itemSlot2: 0,
            itemSlot3: 0,
            itemSlot4: 0,
            itemSlot5: 0,
            itemSlot6: 0,
          },
        }),
      ],
      selection,
    );
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.heroName).toBe('Orphan');
  });
});

describe('pickRecentApiCombatGames', () => {
  it('sorts newest first, caps limit, and ISO-serializes completedAt with items', () => {
    const names = new Map<number, string>([[7, 'Oken']]);
    const recent = pickRecentApiCombatGames(
      [
        combatRow({
          matchId: 'old',
          completedAt: new Date('2026-01-01T00:00:00Z'),
          itemObjectIds: [7],
        }),
        combatRow({
          matchId: 'new',
          completedAt: new Date('2026-01-20T00:00:00Z'),
          itemObjectIds: [7, 8],
        }),
        combatRow({
          matchId: 'mid',
          completedAt: new Date('2026-01-10T00:00:00Z'),
          itemObjectIds: [],
        }),
      ],
      2,
      names,
    );

    expect(recent.map((row) => row.matchId)).toEqual(['new', 'mid']);
    expect(recent[0]!.completedAt).toBe('2026-01-20T00:00:00.000Z');
    expect(recent[0]!.items).toEqual([
      { objectId: 7, name: 'Oken' },
      { objectId: 8, name: null },
    ]);
  });
});

describe('loadApiHeroCombatStats', () => {
  beforeEach(() => {
    matchPlayerFindMany.mockReset();
    gameItemFindMany.mockReset();
    resolveHeroSelectionMock.mockReset();
    resolveHeroSelectionByObjectIdMock.mockReset();
  });

  it('returns null when hero selection is unknown', async () => {
    resolveHeroSelectionMock.mockResolvedValue(null);

    await expect(
      loadApiHeroCombatStats({
        leagueId: 'league-1',
        gameId: 'warcraft3_wos',
        heroKey: 'Missing',
        query: defaultQuery(),
      }),
    ).resolves.toBeNull();
    expect(matchPlayerFindMany).not.toHaveBeenCalled();
  });

  it('resolves numeric objectId keys and returns null when no matching completed rows', async () => {
    resolveHeroSelectionByObjectIdMock.mockResolvedValue(raidenSelection);
    matchPlayerFindMany.mockResolvedValue([
      prismaCombatSource({
        matchId: 'other',
        stats: {
          heroName: 'Frieren',
          heroObjectId: 102,
          kills: 1,
          deaths: 1,
          damagePhys: 1,
          damageMagic: 1,
          damageTotal: 2,
          takenPhys: 0,
          takenMagic: 0,
          takenTotal: 0,
          heal: 0,
          itemSlot1: 0,
          itemSlot2: 0,
          itemSlot3: 0,
          itemSlot4: 0,
          itemSlot5: 0,
          itemSlot6: 0,
        },
      }),
    ]);

    await expect(
      loadApiHeroCombatStats({
        leagueId: 'league-1',
        gameId: 'warcraft3_wos',
        heroKey: '101',
        query: defaultQuery(),
      }),
    ).resolves.toBeNull();

    expect(resolveHeroSelectionByObjectIdMock).toHaveBeenCalledWith(
      'warcraft3_wos',
      'league-1',
      101,
    );
    expect(resolveHeroSelectionMock).not.toHaveBeenCalled();
  });

  it('resolves already-decoded name keys, builds both windows, and recentGames from last pool', async () => {
    resolveHeroSelectionMock.mockResolvedValue(raidenSelection);
    matchPlayerFindMany.mockResolvedValue([
      prismaCombatSource({
        matchId: 'm-old',
        match: { completedAt: new Date('2026-01-01T00:00:00Z') },
      }),
      prismaCombatSource({
        matchId: 'm-new',
        playerId: 'p2',
        result: MatchResult.LOSS,
        player: { username: 'Bob' },
        match: { completedAt: new Date('2026-01-20T00:00:00Z') },
        stats: {
          heroName: 'Raiden Ei',
          heroObjectId: 101,
          kills: 1,
          deaths: 3,
          damagePhys: 100,
          damageMagic: 100,
          damageTotal: 200,
          takenPhys: 50,
          takenMagic: 50,
          takenTotal: 100,
          heal: 10,
          itemSlot1: 1,
          itemSlot2: 0,
          itemSlot3: 0,
          itemSlot4: 0,
          itemSlot5: 0,
          itemSlot6: 0,
        },
      }),
    ]);
    gameItemFindMany.mockResolvedValue([{ objectId: 1, name: 'Oken' }]);

    const result = await loadApiHeroCombatStats({
      leagueId: 'league-1',
      gameId: 'warcraft3_wos',
      heroKey: 'Raiden Ei',
      query: defaultQuery({ scope: 'both', games: 1, recentLimit: 5, topPlayers: 0 }),
    });

    expect(resolveHeroSelectionMock).toHaveBeenCalledWith('warcraft3_wos', 'league-1', 'Raiden Ei');
    expect(matchPlayerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          result: { in: [MatchResult.WIN, MatchResult.LOSS] },
          match: { leagueId: 'league-1', status: MatchStatus.COMPLETED },
        }),
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.hero).toEqual({ objectId: 101, name: 'Raiden Ei' });
    expect(result!.windows.all?.games).toBe(2);
    expect(result!.windows.last?.games).toBe(1);
    expect(result!.windows.range).toBeUndefined();
    expect(result!.recentGames).toHaveLength(1);
    expect(result!.recentGames[0]!.matchId).toBe('m-new');
    expect(result!.recentGames[0]!.items).toEqual([{ objectId: 1, name: 'Oken' }]);
  });

  it('builds range window with to defaulting to now when null', async () => {
    resolveHeroSelectionMock.mockResolvedValue(raidenSelection);
    matchPlayerFindMany.mockResolvedValue([
      prismaCombatSource({
        matchId: 'in-range',
        match: { completedAt: new Date('2026-01-10T00:00:00Z') },
      }),
      prismaCombatSource({
        matchId: 'before',
        match: { completedAt: new Date('2025-01-01T00:00:00Z') },
      }),
    ]);
    gameItemFindMany.mockResolvedValue([]);

    const result = await loadApiHeroCombatStats({
      leagueId: 'league-1',
      gameId: 'warcraft3_wos',
      heroKey: 'Raiden Ei',
      query: defaultQuery({
        scope: 'range',
        from: new Date('2026-01-01T00:00:00Z'),
        to: null,
        topPlayers: 0,
      }),
    });

    expect(result!.windows.range?.games).toBe(1);
    expect(result!.windows.all).toBeUndefined();
    expect(result!.recentGames.map((row) => row.matchId)).toEqual(['in-range']);
  });
});

describe('loadApiMatchCombatStats', () => {
  beforeEach(() => {
    matchFindFirst.mockReset();
    gameItemFindMany.mockReset();
  });

  it('returns null when match is missing for the league', async () => {
    matchFindFirst.mockResolvedValue(null);

    await expect(
      loadApiMatchCombatStats({
        leagueId: 'league-1',
        gameId: 'warcraft3_wos',
        matchId: 'missing',
      }),
    ).resolves.toBeNull();
  });

  it('omits players without stats and includes non-COMPLETED matches', async () => {
    matchFindFirst.mockResolvedValue({
      id: 'match-1',
      leagueId: 'league-1',
      status: MatchStatus.WAITING_FOR_APPROVAL,
      completedAt: null,
      statsReport: { externalId: 'ext-9' },
      players: [
        {
          playerId: 'p1',
          team: 1,
          slot: 1,
          result: MatchResult.WIN,
          player: { username: 'Alice' },
          stats: {
            heroName: 'Raiden Ei',
            heroObjectId: 101,
            kills: 2,
            deaths: 1,
            trainDeaths: 0,
            damagePhys: 100,
            damageMagic: 200,
            damageTotal: 300,
            takenPhys: 10,
            takenMagic: 20,
            takenTotal: 30,
            heal: 5,
            itemSlot1: 1,
            itemSlot2: 0,
            itemSlot3: 0,
            itemSlot4: 0,
            itemSlot5: 0,
            itemSlot6: 0,
          },
        },
        {
          playerId: 'p2',
          team: 2,
          slot: 7,
          result: null,
          player: { username: 'NoStats' },
          stats: null,
        },
      ],
    });
    gameItemFindMany.mockResolvedValue([{ objectId: 1, name: 'Oken' }]);

    const result = await loadApiMatchCombatStats({
      leagueId: 'league-1',
      gameId: 'warcraft3_wos',
      matchId: 'match-1',
    });

    expect(result).toEqual({
      matchId: 'match-1',
      leagueId: 'league-1',
      status: MatchStatus.WAITING_FOR_APPROVAL,
      externalId: 'ext-9',
      completedAt: null,
      players: [
        {
          playerId: 'p1',
          username: 'Alice',
          team: 1,
          slot: 1,
          result: MatchResult.WIN,
          kills: 2,
          deaths: 1,
          trainDeaths: 0,
          damagePhys: 100,
          damageMagic: 200,
          damageTotal: 300,
          takenPhys: 10,
          takenMagic: 20,
          takenTotal: 30,
          heal: 5,
          heroObjectId: 101,
          heroName: 'Raiden Ei',
          items: [{ objectId: 1, name: 'Oken' }],
        },
      ],
    });
    expect(matchFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'match-1', leagueId: 'league-1' },
      }),
    );
  });
});
