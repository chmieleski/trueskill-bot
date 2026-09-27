import { beforeEach, describe, expect, it, vi } from 'vitest';

const matchPlayerFindMany = vi.fn();
const gameHeroFindMany = vi.fn();

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    matchPlayer: {
      findMany: (...args: unknown[]) => matchPlayerFindMany(...args),
    },
    gameHero: {
      findMany: (...args: unknown[]) => gameHeroFindMany(...args),
    },
  },
}));

import { listWosHeroNamesForLeague, listWosHeroesForLeague } from './wos-hero-names.js';

describe('listWosHeroesForLeague', () => {
  beforeEach(() => {
    matchPlayerFindMany.mockReset();
    gameHeroFindMany.mockReset();
  });

  it('returns distinct heroes with objectIds, preferring catalog names, sorted by name', async () => {
    matchPlayerFindMany.mockResolvedValue([
      { stats: { heroName: 'Raiden Ei', heroObjectId: 101 } },
      { stats: { heroName: 'Raiden Ei', heroObjectId: 101 } },
      { stats: { heroName: 'Orphan Hero', heroObjectId: null } },
      { stats: { heroName: 'Frieren Report', heroObjectId: 102 } },
    ]);
    gameHeroFindMany.mockResolvedValue([
      { objectId: 101, name: 'Raiden' },
      { objectId: 102, name: 'Frieren' },
    ]);

    const heroes = await listWosHeroesForLeague('league-1', 'warcraft3_wos');

    expect(heroes).toEqual([
      { objectId: 102, name: 'Frieren' },
      { objectId: null, name: 'Orphan Hero' },
      { objectId: 101, name: 'Raiden' },
    ]);
    expect(matchPlayerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          match: expect.objectContaining({ leagueId: 'league-1' }),
        }),
      }),
    );
    expect(gameHeroFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          gameId: 'warcraft3_wos',
          objectId: { in: expect.arrayContaining([101, 102]) },
        }),
      }),
    );
  });

  it('falls back to report name when catalog has no entry', async () => {
    matchPlayerFindMany.mockResolvedValue([
      { stats: { heroName: 'Unknown Report', heroObjectId: 999 } },
    ]);
    gameHeroFindMany.mockResolvedValue([]);

    await expect(listWosHeroesForLeague('league-1', 'warcraft3_wos')).resolves.toEqual([
      { objectId: 999, name: 'Unknown Report' },
    ]);
  });
});

describe('listWosHeroNamesForLeague', () => {
  beforeEach(() => {
    matchPlayerFindMany.mockReset();
    gameHeroFindMany.mockReset();
  });

  it('maps listWosHeroesForLeague entries to names only', async () => {
    matchPlayerFindMany.mockResolvedValue([
      { stats: { heroName: 'Beta', heroObjectId: 2 } },
      { stats: { heroName: 'Alpha', heroObjectId: 1 } },
    ]);
    gameHeroFindMany.mockResolvedValue([
      { objectId: 1, name: 'Alpha' },
      { objectId: 2, name: 'Beta' },
    ]);

    await expect(listWosHeroNamesForLeague('league-1', 'warcraft3_wos')).resolves.toEqual([
      'Alpha',
      'Beta',
    ]);
  });
});
