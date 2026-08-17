import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique, update },
  },
}));

vi.mock('../lobby/register-lobby-source.js', () => ({
  assertLeagueAllowsWc3stats: vi.fn(),
  WC3STATS_CONFIG_UNSUPPORTED_MESSAGE: 'Warcraft lobby import is not available for this game.',
}));

import { resolveLeagueConfig } from './league-wc3stats.js';

describe('resolveLeagueConfig lobby channel', () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it('defaults lobby channel to off when the league row is missing', async () => {
    findUnique.mockResolvedValue(null);
    const resolved = await resolveLeagueConfig('league-1');
    expect(resolved.lobbyChannelEnabled).toBe(false);
    expect(resolved.lobbyChannelId).toBeUndefined();
  });

  it('trims a stored lobby channel id', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: true,
      lobbyChannelId: '  chan-1  ',
    });
    const resolved = await resolveLeagueConfig('league-1');
    expect(resolved.lobbyChannelEnabled).toBe(true);
    expect(resolved.lobbyChannelId).toBe('chan-1');
  });
});
