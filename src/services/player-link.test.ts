import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    player: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { assertLinkAllowed } from './player-link.js';
import { PlayerServiceError } from './player-profile.js';

describe('assertLinkAllowed', () => {
  it('rejects missing nick', () => {
    expect(() =>
      assertLinkAllowed({ player: null, existingByDiscord: null }),
    ).toThrow('No player with that nick.');
  });

  it('rejects nick already linked', () => {
    expect(() =>
      assertLinkAllowed({
        player: { id: '1', username: 'Tinys', discordId: 'd1' },
        existingByDiscord: null,
      }),
    ).toThrow(PlayerServiceError);
  });

  it('rejects discord already linked to another player', () => {
    expect(() =>
      assertLinkAllowed({
        player: { id: '1', username: 'Tinys', discordId: null },
        existingByDiscord: { id: '2', username: 'Other', discordId: 'd9' },
      }),
    ).toThrow('That nick or Discord account is already linked.');
  });

  it('allows a free nick and free discord', () => {
    const player = { id: '1', username: 'Tinys', discordId: null };
    expect(
      assertLinkAllowed({ player, existingByDiscord: null }),
    ).toEqual(player);
  });

  it('allows discord already linked to the same player', () => {
    const player = { id: '1', username: 'Tinys', discordId: null };
    const existingByDiscord = { id: '1', username: 'Tinys', discordId: 'd9' };
    expect(assertLinkAllowed({ player, existingByDiscord })).toEqual(player);
  });
});
