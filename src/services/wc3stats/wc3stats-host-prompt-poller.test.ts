import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findMany } = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    player: { findMany },
    league: { findMany: vi.fn() },
  },
}));

vi.mock('../../config/env.js', () => ({
  env: { wc3statsTimeoutMs: 4000 },
}));

import { loadLinkedPlayersByNick } from './wc3stats-host-prompt-poller.js';

describe('loadLinkedPlayersByNick', () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it('queries only linked players who opted into host prompt pings', async () => {
    findMany.mockResolvedValue([
      { username: 'Goku', discordId: 'd-goku' },
      { username: 'Vegeta', discordId: 'd-vegeta' },
    ]);

    const map = await loadLinkedPlayersByNick();

    expect(findMany).toHaveBeenCalledWith({
      where: {
        discordId: { not: null },
        wc3statsHostPromptPingsEnabled: true,
      },
      select: { username: true, discordId: true },
    });
    expect(map.get('goku')).toBe('d-goku');
    expect(map.get('vegeta')).toBe('d-vegeta');
  });
});
