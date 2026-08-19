import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique, findMany, update, create } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => {
  const player = { findUnique, findMany, update, create };
  return {
    prisma: {
      player,
      $transaction: async (fn: (tx: { player: typeof player }) => Promise<unknown>) =>
        fn({ player }),
    },
  };
});

import { assertLinkAllowed, linkPlayer } from './player-link.js';
import { PlayerServiceError } from './player-profile.js';

const GAME_ID = 'warcraft3_udbr';

const ALREADY_LINKED = 'That nick or Discord account is already linked. Ask a moderator to relink.';

describe('assertLinkAllowed', () => {
  it('rejects nick already linked', () => {
    expect(() =>
      assertLinkAllowed({
        player: { id: '1', username: 'Tinys', discordId: 'd1' },
        existingByDiscord: null,
        discordId: 'd2',
      }),
    ).toThrow(PlayerServiceError);
  });

  it('rejects discord already linked to another player', () => {
    expect(() =>
      assertLinkAllowed({
        player: { id: '1', username: 'Tinys', discordId: null },
        existingByDiscord: { id: '2', username: 'Other', discordId: 'd9' },
        discordId: 'd9',
      }),
    ).toThrow(ALREADY_LINKED);
  });

  it('allows a free nick and free discord', () => {
    expect(() =>
      assertLinkAllowed({
        player: { id: '1', username: 'Tinys', discordId: null },
        existingByDiscord: null,
        discordId: 'd1',
      }),
    ).not.toThrow();
  });

  it('allows the same nick and discord already bound together', () => {
    expect(() =>
      assertLinkAllowed({
        player: { id: '1', username: 'Tinys', discordId: 'd1' },
        existingByDiscord: { id: '1', username: 'Tinys', discordId: 'd1' },
        discordId: 'd1',
      }),
    ).not.toThrow();
  });

  it('allows discord already linked to the same player row', () => {
    expect(() =>
      assertLinkAllowed({
        player: { id: '1', username: 'Tinys', discordId: null },
        existingByDiscord: { id: '1', username: 'Tinys', discordId: 'd9' },
        discordId: 'd9',
      }),
    ).not.toThrow();
  });

  it('allows relink when nick is taken if allowRelink is set', () => {
    expect(() =>
      assertLinkAllowed({
        player: { id: '1', username: 'Tinys', discordId: 'd1' },
        existingByDiscord: null,
        discordId: 'd2',
        allowRelink: true,
      }),
    ).not.toThrow();
  });

  it('allows relink when discord is taken if allowRelink is set', () => {
    expect(() =>
      assertLinkAllowed({
        player: { id: '1', username: 'Tinys', discordId: null },
        existingByDiscord: { id: '2', username: 'Other', discordId: 'd9' },
        discordId: 'd9',
        allowRelink: true,
      }),
    ).not.toThrow();
  });

  it('rejects creating a new nick when discord is already linked', () => {
    expect(() =>
      assertLinkAllowed({
        player: null,
        existingByDiscord: { id: '2', username: 'Other', discordId: 'd9' },
        discordId: 'd9',
      }),
    ).toThrow(ALREADY_LINKED);
  });
});

describe('linkPlayer', () => {
  beforeEach(() => {
    findUnique.mockReset();
    findMany.mockReset();
    update.mockReset();
    create.mockReset();
  });

  it('rejects an empty nick without creating', async () => {
    await expect(linkPlayer({ gameId: GAME_ID, nick: '   ', discordId: 'd1' })).rejects.toThrow(
      'Nick cannot be empty.',
    );
    expect(create).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('creates and links a player when the nick does not exist', async () => {
    findUnique.mockResolvedValue(null);
    findMany.mockResolvedValue([]);
    create.mockResolvedValue({
      id: 'new',
      username: 'ghost',
      discordId: 'd1',
      gameId: GAME_ID,
    });

    const linked = await linkPlayer({ gameId: GAME_ID, nick: 'Ghost', discordId: 'd1' });

    expect(linked).toEqual({ username: 'ghost', discordId: 'd1', gameId: GAME_ID });
    expect(create).toHaveBeenCalledWith({
      data: { gameId: GAME_ID, username: 'ghost', discordId: 'd1' },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('does not create when the Discord account is already linked', async () => {
    findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      const discordWhere = where.gameId_discordId as
        { gameId: string; discordId: string } | undefined;
      if (discordWhere?.discordId === 'd9') {
        return { id: '2', username: 'Other', discordId: 'd9' };
      }
      return null;
    });
    findMany.mockResolvedValue([]);

    await expect(linkPlayer({ gameId: GAME_ID, nick: 'Ghost', discordId: 'd9' })).rejects.toThrow(
      ALREADY_LINKED,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('updates an existing unlinked player', async () => {
    const player = { id: '1', username: 'Tinys', discordId: null, gameId: GAME_ID };
    findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      const nickWhere = where.gameId_username as { gameId: string; username: string } | undefined;
      if (nickWhere?.username === 'tinys') {
        return player;
      }
      return null;
    });
    update.mockResolvedValue({ id: '1', username: 'Tinys', discordId: 'd1', gameId: GAME_ID });

    const linked = await linkPlayer({ gameId: GAME_ID, nick: 'Tinys', discordId: 'd1' });

    expect(linked).toEqual({ username: 'Tinys', discordId: 'd1', gameId: GAME_ID });
    expect(update).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        gameId_username: { gameId: GAME_ID, username: 'tinys' },
      },
    });
  });

  it('is a no-op when the same nick and discord are already linked', async () => {
    const player = { id: '1', username: 'Tinys', discordId: 'd1', gameId: GAME_ID };
    findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      const nickWhere = where.gameId_username as { gameId: string; username: string } | undefined;
      const discordWhere = where.gameId_discordId as
        { gameId: string; discordId: string } | undefined;
      if (nickWhere?.username === 'tinys' || discordWhere?.discordId === 'd1') {
        return player;
      }
      return null;
    });

    const linked = await linkPlayer({ gameId: GAME_ID, nick: 'Tinys', discordId: 'd1' });

    expect(linked).toEqual({ username: 'Tinys', discordId: 'd1', gameId: GAME_ID });
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('moves an existing discord link when allowRelink is set', async () => {
    const tinys = { id: '1', username: 'Tinys', discordId: null, gameId: GAME_ID };
    const other = { id: '2', username: 'Other', discordId: 'd9', gameId: GAME_ID };
    findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      const nickWhere = where.gameId_username as { gameId: string; username: string } | undefined;
      const discordWhere = where.gameId_discordId as
        { gameId: string; discordId: string } | undefined;
      if (nickWhere?.username === 'tinys') {
        return tinys;
      }
      if (discordWhere?.discordId === 'd9') {
        return other;
      }
      return null;
    });
    update.mockImplementation(async ({ where, data }: { where: { id: string }; data: object }) => {
      if (where.id === '2') {
        return { ...other, discordId: null };
      }
      return { ...tinys, ...data, gameId: GAME_ID };
    });

    const linked = await linkPlayer({
      gameId: GAME_ID,
      nick: 'Tinys',
      discordId: 'd9',
      allowRelink: true,
    });

    expect(linked).toEqual({ username: 'Tinys', discordId: 'd9', gameId: GAME_ID });
    expect(update).toHaveBeenNthCalledWith(1, {
      where: { id: '2' },
      data: { discordId: null },
    });
    expect(update).toHaveBeenNthCalledWith(2, {
      where: { id: '1' },
      data: { discordId: 'd9' },
    });
  });

  it('overwrites a nick already linked to another discord when allowRelink is set', async () => {
    const tinys = { id: '1', username: 'Tinys', discordId: 'd1', gameId: GAME_ID };
    findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      const nickWhere = where.gameId_username as { gameId: string; username: string } | undefined;
      if (nickWhere?.username === 'tinys') {
        return tinys;
      }
      return null;
    });
    update.mockResolvedValue({ id: '1', username: 'Tinys', discordId: 'd2', gameId: GAME_ID });

    const linked = await linkPlayer({
      gameId: GAME_ID,
      nick: 'Tinys',
      discordId: 'd2',
      allowRelink: true,
    });

    expect(linked).toEqual({ username: 'Tinys', discordId: 'd2', gameId: GAME_ID });
    expect(update).toHaveBeenCalledWith({
      where: { id: '1' },
      data: { discordId: 'd2' },
    });
  });

  it('links the same discord to different nicks on different games', async () => {
    findUnique
      .mockResolvedValueOnce(null) // nick on anime
      .mockResolvedValueOnce(null); // discord on anime
    findMany.mockResolvedValue([]);
    create.mockResolvedValue({
      id: 'p2',
      username: 'Vegeta',
      discordId: 'd1',
      gameId: 'warcraft3_anime_choice_arena',
    });

    const linked = await linkPlayer({
      gameId: 'warcraft3_anime_choice_arena',
      nick: 'Vegeta',
      discordId: 'd1',
    });

    expect(linked.gameId).toBe('warcraft3_anime_choice_arena');
    expect(create).toHaveBeenCalledWith({
      data: {
        gameId: 'warcraft3_anime_choice_arena',
        username: 'vegeta',
        discordId: 'd1',
      },
    });
  });
});
