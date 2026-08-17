import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchServiceError } from '../match/match-service.js';

const { findUnique } = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    player: {
      findUnique,
    },
  },
}));

import { nickForDiscordId, UNLINKED_DISCORD_MESSAGE } from './lobby-identity.js';

describe('nickForDiscordId', () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it('looks up by gameId and discordId', async () => {
    findUnique.mockResolvedValue({ username: 'goku' });
    await expect(nickForDiscordId('d1', 'warcraft3_udbr')).resolves.toBe('goku');
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        gameId_discordId: { gameId: 'warcraft3_udbr', discordId: 'd1' },
      },
    });
  });

  it('throws when Discord is not linked', async () => {
    findUnique.mockResolvedValue(null);

    await expect(nickForDiscordId('d-missing', 'warcraft3_udbr')).rejects.toThrow(
      MatchServiceError,
    );
    await expect(nickForDiscordId('d-missing', 'warcraft3_udbr')).rejects.toThrow(
      UNLINKED_DISCORD_MESSAGE,
    );
  });
});
