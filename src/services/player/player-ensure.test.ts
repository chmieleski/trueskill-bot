import { beforeEach, describe, expect, it, vi } from 'vitest';

const playerFindUnique = vi.fn();
const playerFindMany = vi.fn();
const playerCreate = vi.fn();
const linkPlayer = vi.fn();

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    player: {
      findUnique: (...args: unknown[]) => playerFindUnique(...args),
      findMany: (...args: unknown[]) => playerFindMany(...args),
      create: (...args: unknown[]) => playerCreate(...args),
    },
  },
}));

vi.mock('./player-link.js', () => ({
  linkPlayer: (...args: unknown[]) => linkPlayer(...args),
}));

const { ensurePlayerForModLookup } = await import('./player-ensure.js');

const GAME_ID = 'warcraft3_udbr';

describe('ensurePlayerForModLookup', () => {
  beforeEach(() => {
    playerFindUnique.mockReset();
    playerFindMany.mockReset();
    playerCreate.mockReset();
    linkPlayer.mockReset();
  });

  it('returns an existing player by nick without creating', async () => {
    playerFindUnique.mockResolvedValue({ id: 'p1', username: 'ghost' });

    const result = await ensurePlayerForModLookup(GAME_ID, { kind: 'nick', nick: 'Ghost' });

    expect(result).toEqual({ id: 'p1', username: 'ghost', created: false });
    expect(playerCreate).not.toHaveBeenCalled();
  });

  it('creates a player when the nick is unknown', async () => {
    playerFindUnique.mockResolvedValue(null);
    playerFindMany.mockResolvedValue([]);
    playerCreate.mockResolvedValue({ id: 'p-new', username: 'rmkquitter' });

    const result = await ensurePlayerForModLookup(GAME_ID, { kind: 'nick', nick: 'RmkQuitter' });

    expect(result).toEqual({ id: 'p-new', username: 'rmkquitter', created: true });
    expect(playerCreate).toHaveBeenCalledWith({
      data: { gameId: GAME_ID, username: 'rmkquitter' },
      select: { id: true, username: true },
    });
  });

  it('links a Discord user when unlinked and a display name is provided', async () => {
    playerFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'p-discord', username: 'modtarget' });
    linkPlayer.mockResolvedValue({
      username: 'modtarget',
      discordId: 'd1',
      gameId: GAME_ID,
    });

    const result = await ensurePlayerForModLookup(
      GAME_ID,
      { kind: 'user', discordId: 'd1' },
      { discordUsername: 'ModTarget' },
    );

    expect(result).toEqual({ id: 'p-discord', username: 'modtarget', created: true });
    expect(linkPlayer).toHaveBeenCalledWith({
      gameId: GAME_ID,
      nick: 'ModTarget',
      discordId: 'd1',
    });
  });

  it('throws when a Discord user is unlinked and no display name is provided', async () => {
    playerFindUnique.mockResolvedValue(null);

    await expect(
      ensurePlayerForModLookup(GAME_ID, { kind: 'user', discordId: 'd1' }),
    ).rejects.toThrow('Player not found.');
    expect(linkPlayer).not.toHaveBeenCalled();
  });
});
