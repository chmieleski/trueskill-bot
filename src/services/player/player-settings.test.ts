import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    player: { findUnique, update },
  },
}));

import {
  getPlayerHostPromptPingsEnabled,
  setPlayerHostPromptPingsEnabled,
} from './player-settings.js';
import { PlayerServiceError } from './player-profile.js';

describe('getPlayerHostPromptPingsEnabled', () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it('returns null when no linked player exists', async () => {
    findUnique.mockResolvedValue(null);
    await expect(getPlayerHostPromptPingsEnabled('d1')).resolves.toBeNull();
  });

  it('returns true by default when the flag is true', async () => {
    findUnique.mockResolvedValue({
      username: 'goku',
      wc3statsHostPromptPingsEnabled: true,
    });
    await expect(getPlayerHostPromptPingsEnabled('d1')).resolves.toBe(true);
  });

  it('returns false when the player opted out', async () => {
    findUnique.mockResolvedValue({
      username: 'goku',
      wc3statsHostPromptPingsEnabled: false,
    });
    await expect(getPlayerHostPromptPingsEnabled('d1')).resolves.toBe(false);
  });
});

describe('setPlayerHostPromptPingsEnabled', () => {
  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
  });

  it('rejects when the Discord user is not linked', async () => {
    findUnique.mockResolvedValue(null);
    await expect(setPlayerHostPromptPingsEnabled('d1', false)).rejects.toThrow(
      PlayerServiceError,
    );
    await expect(setPlayerHostPromptPingsEnabled('d1', false)).rejects.toThrow(
      'Link your nick with /link before changing host lobby prompt settings.',
    );
  });

  it('persists the preference for a linked player', async () => {
    findUnique.mockResolvedValue({ id: 'p1', username: 'goku', discordId: 'd1' });
    update.mockResolvedValue({
      username: 'goku',
      wc3statsHostPromptPingsEnabled: false,
    });

    await expect(setPlayerHostPromptPingsEnabled('d1', false)).resolves.toEqual({
      username: 'goku',
      enabled: false,
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { wc3statsHostPromptPingsEnabled: false },
      select: { username: true, wc3statsHostPromptPingsEnabled: true },
    });
  });
});
