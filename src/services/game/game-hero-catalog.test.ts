import { beforeEach, describe, expect, it, vi } from 'vitest';

const upsertMock = vi.fn();
const findManyMock = vi.fn();
const findFirstMock = vi.fn();
const updateManyMock = vi.fn();

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    gameHero: {
      upsert: (...args: unknown[]) => upsertMock(...args),
      findMany: (...args: unknown[]) => findManyMock(...args),
      findFirst: (...args: unknown[]) => findFirstMock(...args),
    },
    matchPlayerStats: {
      findFirst: (...args: unknown[]) => findFirstMock(...args),
      updateMany: (...args: unknown[]) => updateManyMock(...args),
    },
  },
}));

import {
  formatHeroDisplayName,
  renameGameHeroDisplayName,
  resolveHeroDisplayNames,
  statsRowMatchesHeroSelection,
  upsertGameHeroesFromReport,
} from './game-hero-catalog.js';

describe('upsertGameHeroesFromReport', () => {
  beforeEach(() => {
    upsertMock.mockReset();
  });

  it('inserts heroes from report players without updating existing rows', async () => {
    await upsertGameHeroesFromReport('warcraft3_wos', [
      { objectId: 101, name: 'Raiden Ei' },
      { objectId: 102, name: 'Frieren' },
    ]);

    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { gameId_objectId: { gameId: 'warcraft3_wos', objectId: 101 } },
        create: { gameId: 'warcraft3_wos', objectId: 101, name: 'Raiden Ei' },
        update: {},
      }),
    );
  });

  it('skips rows without object id or name', async () => {
    await upsertGameHeroesFromReport('warcraft3_wos', [
      { objectId: null, name: 'Orphan' },
      { objectId: 5, name: null },
    ]);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe('resolveHeroDisplayNames', () => {
  beforeEach(() => {
    findManyMock.mockReset();
  });

  it('returns map of objectId to display name', async () => {
    findManyMock.mockResolvedValue([{ objectId: 101, name: 'Raiden' }]);

    const map = await resolveHeroDisplayNames('warcraft3_wos', [101, 999]);
    expect(map.get(101)).toBe('Raiden');
    expect(map.get(999)).toBeUndefined();
  });
});

describe('formatHeroDisplayName', () => {
  it('prefers catalog name over fallback', () => {
    expect(formatHeroDisplayName(101, new Map([[101, 'Raiden']]), 'Raiden Ei')).toBe('Raiden');
  });

  it('falls back to report name then unknown', () => {
    expect(formatHeroDisplayName(101, new Map(), 'Raiden Ei')).toBe('Raiden Ei');
    expect(formatHeroDisplayName(null, new Map(), null)).toBe('Unknown hero');
  });
});

describe('statsRowMatchesHeroSelection', () => {
  it('matches by object id when present', () => {
    const selection = { objectId: 101, nameKey: 'raiden', displayName: 'Raiden' };
    expect(
      statsRowMatchesHeroSelection({ heroObjectId: 101, heroName: 'Raiden Ei' }, selection),
    ).toBe(true);
    expect(
      statsRowMatchesHeroSelection({ heroObjectId: 102, heroName: 'Raiden Ei' }, selection),
    ).toBe(false);
  });

  it('matches by name when object id is absent', () => {
    const selection = { objectId: null, nameKey: 'frieren', displayName: 'Frieren' };
    expect(
      statsRowMatchesHeroSelection({ heroObjectId: null, heroName: 'Frieren' }, selection),
    ).toBe(true);
  });
});

describe('renameGameHeroDisplayName', () => {
  beforeEach(() => {
    findFirstMock.mockReset();
    upsertMock.mockReset();
    updateManyMock.mockReset();
  });

  it('upserts catalog name when object id is known', async () => {
    findFirstMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ heroObjectId: 101, heroName: 'Raiden Ei' });

    const result = await renameGameHeroDisplayName({
      gameId: 'warcraft3_wos',
      leagueId: 'league-1',
      currentName: 'Raiden Ei',
      displayName: 'Raiden',
    });

    expect(result).toEqual({ objectId: 101, displayName: 'Raiden' });
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { name: 'Raiden' },
      }),
    );
  });
});
