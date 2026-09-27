import { beforeEach, describe, expect, it, vi } from 'vitest';

const { leagueFindUnique, matchFindUnique, getGameProfileForLeague } = vi.hoisted(() => ({
  leagueFindUnique: vi.fn(),
  matchFindUnique: vi.fn(),
  getGameProfileForLeague: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique: leagueFindUnique },
    match: { findUnique: matchFindUnique },
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

import { LEAGUE_ARCHIVED_MESSAGE, LEAGUE_SEASON_PAUSED_MESSAGE } from '../league/league.js';
import { createPendingMatch, MatchServiceError, startMatch } from './match-service.js';

describe('createPendingMatch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects when the league is archived', async () => {
    leagueFindUnique.mockResolvedValue({ status: 'ARCHIVED', seasonEndsAt: null });

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

  it('rejects when the season is soft-paused', async () => {
    leagueFindUnique.mockResolvedValue({
      status: 'ACTIVE',
      seasonEndsAt: new Date('2020-01-01T00:00:00.000Z'),
    });

    await expect(
      createPendingMatch({
        leagueId: 'league-paused',
        hostDiscordId: 'host-1',
        discordChannelId: 'channel-1',
        players: [],
      }),
    ).rejects.toThrow(LEAGUE_SEASON_PAUSED_MESSAGE);
    expect(getGameProfileForLeague).not.toHaveBeenCalled();
  });
});

describe('startMatch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects when the league season is soft-paused', async () => {
    matchFindUnique.mockResolvedValue({
      id: 'match-1',
      status: 'PENDING',
      leagueId: 'league-paused',
      eventId: null,
      players: [],
    });
    leagueFindUnique.mockResolvedValue({
      status: 'ACTIVE',
      seasonEndsAt: new Date('2020-01-01T00:00:00.000Z'),
    });

    await expect(startMatch('match-1')).rejects.toThrow(LEAGUE_SEASON_PAUSED_MESSAGE);
  });
});
