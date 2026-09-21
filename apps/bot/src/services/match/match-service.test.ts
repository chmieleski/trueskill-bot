import { beforeEach, describe, expect, it, vi } from 'vitest';

const { leagueFindUnique, getGameProfileForLeague } = vi.hoisted(() => ({
  leagueFindUnique: vi.fn(),
  getGameProfileForLeague: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique: leagueFindUnique },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('../league/league-profile.js', () => ({
  getGameProfileForLeague,
  LeagueNotFoundError: class LeagueNotFoundError extends Error {},
}));

import { LEAGUE_ARCHIVED_MESSAGE } from '../league/league.js';
import { createPendingMatch, MatchServiceError } from './match-service.js';

describe('createPendingMatch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects when the league is archived', async () => {
    leagueFindUnique.mockResolvedValue({ status: 'ARCHIVED' });

    await expect(
      createPendingMatch({
        leagueId: 'league-archived',
        hostDiscordId: 'host-1',
        discordChannelId: 'channel-1',
        players: [],
      }),
    ).rejects.toThrow(MatchServiceError);
    await expect(
      createPendingMatch({
        leagueId: 'league-archived',
        hostDiscordId: 'host-1',
        discordChannelId: 'channel-1',
        players: [],
      }),
    ).rejects.toThrow(LEAGUE_ARCHIVED_MESSAGE);
    expect(getGameProfileForLeague).not.toHaveBeenCalled();
  });
});
