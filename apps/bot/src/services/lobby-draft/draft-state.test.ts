import type { LobbyDraft } from '@dbz/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateMany, findUnique } = vi.hoisted(() => ({ updateMany: vi.fn(), findUnique: vi.fn() }));
vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    lobbyDraft: { updateMany, findUnique, findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  },
}));

import { parseLobbyDraftState, saveLobbyDraftState } from './draft-state.js';
import { initialLobbyDraftState, LobbyDraftConflictError, LobbyDraftError } from './draft-types.js';

const state = initialLobbyDraftState([{ key: 'a', nick: 'A', discordId: '1' }], null);
const row = {
  id: 'd1',
  status: 'ACTIVE',
  state,
  updatedAt: new Date(1000),
} as unknown as LobbyDraft;

describe('draft-state', () => {
  beforeEach(() => vi.clearAllMocks());

  it('round-trips state and rejects garbage', () => {
    expect(parseLobbyDraftState(row)).toEqual(state);
    expect(() =>
      parseLobbyDraftState({ ...row, state: { phase: 'NOPE' } } as unknown as LobbyDraft),
    ).toThrow(LobbyDraftError);
  });

  it('saves only when updatedAt still matches', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(saveLobbyDraftState(row, state)).rejects.toBeInstanceOf(LobbyDraftConflictError);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'd1', status: 'ACTIVE', updatedAt: row.updatedAt } }),
    );

    updateMany.mockResolvedValueOnce({ count: 1 });
    findUnique.mockResolvedValueOnce(row);
    await expect(saveLobbyDraftState(row, state)).resolves.toBe(row);
  });
});
