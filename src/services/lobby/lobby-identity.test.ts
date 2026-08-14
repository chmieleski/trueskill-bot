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

  it('returns the linked username', async () => {
    findUnique.mockResolvedValue({ id: 'p1', username: 'goku', discordId: 'd1' });

    await expect(nickForDiscordId('d1')).resolves.toBe('goku');
    expect(findUnique).toHaveBeenCalledWith({ where: { discordId: 'd1' } });
  });

  it('throws when Discord is not linked', async () => {
    findUnique.mockResolvedValue(null);

    await expect(nickForDiscordId('d-missing')).rejects.toThrow(MatchServiceError);
    await expect(nickForDiscordId('d-missing')).rejects.toThrow(UNLINKED_DISCORD_MESSAGE);
  });
});
