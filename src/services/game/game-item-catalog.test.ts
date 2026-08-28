import { beforeEach, describe, expect, it, vi } from 'vitest';

const upsertMock = vi.fn();
const findManyMock = vi.fn();

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    gameItem: {
      upsert: (...args: unknown[]) => upsertMock(...args),
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}));

import { formatItemDisplayName, resolveItemNames, upsertGameItems } from './game-item-catalog.js';

describe('upsertGameItems', () => {
  beforeEach(() => {
    upsertMock.mockReset();
  });

  it('upserts each item rate for the game', async () => {
    await upsertGameItems('warcraft3_wos', [
      { objectId: 1, name: 'Oken' },
      { objectId: 2, name: 'Zangetsu' },
    ]);

    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { gameId_objectId: { gameId: 'warcraft3_wos', objectId: 1 } },
        create: { gameId: 'warcraft3_wos', objectId: 1, name: 'Oken' },
        update: { name: 'Oken' },
      }),
    );
  });

  it('skips empty itemRates array', async () => {
    await upsertGameItems('warcraft3_wos', []);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe('resolveItemNames', () => {
  beforeEach(() => {
    findManyMock.mockReset();
  });

  it('returns map of objectId to name', async () => {
    findManyMock.mockResolvedValue([
      { objectId: 1, name: 'Oken' },
      { objectId: 2, name: 'Zangetsu' },
    ]);

    const map = await resolveItemNames('warcraft3_wos', [1, 2, 99]);
    expect(map.get(1)).toBe('Oken');
    expect(map.get(99)).toBeUndefined();
  });
});

describe('formatItemDisplayName', () => {
  it('falls back to object id when name is unknown', () => {
    expect(formatItemDisplayName(42, new Map())).toBe('Item #42');
  });
});
