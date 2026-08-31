import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Guild } from 'discord.js';
import { CaptainDraftError } from './draft-types.js';
import { resolveParticipantsFromInput } from './draft-resolve.js';

const { playerFindMany } = vi.hoisted(() => ({
  playerFindMany: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    player: { findMany: playerFindMany },
  },
}));

function mockGuild(fetchImpl: (id: string) => Promise<{ displayName: string }>): Guild {
  return {
    members: {
      fetch: vi.fn(fetchImpl),
    },
  } as unknown as Guild;
}

describe('resolveParticipantsFromInput', () => {
  beforeEach(() => {
    playerFindMany.mockReset();
  });

  it('resolves Discord mentions with guild display names', async () => {
    const guild = mockGuild(async (id) => {
      if (id === '111') return { displayName: 'Alice' };
      return { displayName: 'Bob' };
    });

    const result = await resolveParticipantsFromInput({
      raw: '<@111>, <@!222>',
      gameId: null,
      guild,
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ label: 'Alice', discordId: '111' });
    expect(result[1]).toMatchObject({ label: 'Bob', discordId: '222' });
    expect(result[0]!.key).not.toBe(result[1]!.key);
    expect(playerFindMany).not.toHaveBeenCalled();
  });

  it('keeps plain text labels when gameId is unset', async () => {
    const guild = mockGuild(async () => ({ displayName: 'unused' }));

    const result = await resolveParticipantsFromInput({
      raw: 'Tiny, Ghost',
      gameId: null,
      guild,
    });

    expect(result).toEqual([
      expect.objectContaining({ label: 'Tiny' }),
      expect.objectContaining({ label: 'Ghost' }),
    ]);
    expect(result[0]).not.toHaveProperty('discordId');
    expect(playerFindMany).not.toHaveBeenCalled();
  });

  it('links text nicks to discordId via batch Player lookup', async () => {
    const guild = mockGuild(async () => ({ displayName: 'unused' }));
    playerFindMany.mockResolvedValue([
      { username: 'tiny', discordId: '999' },
      { username: 'ghost', discordId: null },
    ]);

    const result = await resolveParticipantsFromInput({
      raw: 'Tiny, Ghost, Unknown',
      gameId: 'warcraft3_udbr',
      guild,
    });

    expect(playerFindMany).toHaveBeenCalledWith({
      where: {
        gameId: 'warcraft3_udbr',
        OR: [
          { username: { equals: 'tiny', mode: 'insensitive' } },
          { username: { equals: 'ghost', mode: 'insensitive' } },
          { username: { equals: 'unknown', mode: 'insensitive' } },
        ],
      },
      select: { username: true, discordId: true },
    });

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ label: 'tiny', discordId: '999' });
    expect(result[1]).toMatchObject({ label: 'ghost' });
    expect(result[1]).not.toHaveProperty('discordId');
    expect(result[2]).toMatchObject({ label: 'Unknown' });
  });

  it('dedupes by discordId and normalized label', async () => {
    const guild = mockGuild(async (id) => ({ displayName: id === '111' ? 'Alice' : 'Bob' }));
    playerFindMany.mockResolvedValue([{ username: 'alice', discordId: '111' }]);

    const result = await resolveParticipantsFromInput({
      raw: '<@111>, alice, Alice, Tiny, tiny',
      gameId: 'warcraft3_udbr',
      guild,
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ label: 'Alice', discordId: '111' });
    expect(result[1]).toMatchObject({ label: 'Tiny' });
  });

  it('throws CaptainDraftError on empty input', async () => {
    const guild = mockGuild(async () => ({ displayName: 'unused' }));

    await expect(
      resolveParticipantsFromInput({ raw: '  ,  ', gameId: null, guild }),
    ).rejects.toThrow(CaptainDraftError);

    await expect(resolveParticipantsFromInput({ raw: '', gameId: null, guild })).rejects.toThrow(
      'Player list cannot be empty.',
    );
  });
});
