import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMatchById, createPendingMatch, assertHasMatchModRole, getGameProfileForLeague } =
  vi.hoisted(() => ({
    getMatchById: vi.fn(),
    createPendingMatch: vi.fn(),
    assertHasMatchModRole: vi.fn(),
    getGameProfileForLeague: vi.fn(),
  }));

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {},
}));

vi.mock('../match/match-auth.js', () => ({
  assertHasMatchModRole,
  hasMatchModRole: vi.fn(() => true),
}));

vi.mock('../match/match-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../match/match-service.js')>();
  return {
    ...actual,
    getMatchById,
    createPendingMatch,
    attachDiscordMessage: vi.fn(),
  };
});

vi.mock('../league/league-lobby-channel.js', () => ({
  assertLeagueLobbyCreateChannel: vi.fn(),
}));

vi.mock('../league/league-profile.js', () => ({
  getGameProfileForLeague,
}));

vi.mock('../league/league-wc3stats.js', () => ({
  isLeagueWc3statsImportReady: vi.fn(() => false),
  resolveLeagueConfig: vi.fn(async () => ({ lobbyPlayerClaimEnabled: true })),
}));

vi.mock('../rating/index.js', () => ({
  loadLobbyRatingPreview: vi.fn(async () => undefined),
  matchPlayersToRatingEntries: vi.fn(() => []),
}));

vi.mock('../rating/new-player.js', () => ({
  collectNewPlayerSuggestionsForPendingCreate: vi.fn(async () => []),
}));

import { MatchServiceError } from '../match/match-service.js';
import { recreateLobbyFromVoidedMatch } from './recreate-lobby-from-match.js';

const VOIDED_MATCH = {
  id: 'voided-1',
  status: 'CANCELLED' as const,
  completedAt: new Date('2026-08-23T10:00:00Z'),
  leagueId: 'league-1',
  hostDiscordId: 'host-1',
  discordChannelId: 'chan-1',
  discordMessageId: 'msg-1',
  wc3statsGameId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  lobbyRosterAuthorityAt: null,
  players: [
    {
      matchId: 'voided-1',
      playerId: 'p1',
      team: 1,
      slot: 1,
      heroId: 1,
      result: null,
      isQuitter: false,
      isGriffer: false,
      wasNewPlayer: false,
      globalKi: null,
      globalKiDelta: null,
      heroKi: null,
      heroKiDelta: null,
      player: { id: 'p1', gameId: 'warcraft3_udbr', username: 'goku', discordId: null },
    },
  ],
};

describe('recreateLobbyFromVoidedMatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGameProfileForLeague.mockResolvedValue({
      gameId: 'warcraft3_udbr',
      heroBinding: 'slot_bound',
      teamSlotRanges: [{ team: 1, minSlot: 1, maxSlot: 6 }],
    });
  });

  it('rejects non-voided matches', async () => {
    getMatchById.mockResolvedValue({
      ...VOIDED_MATCH,
      status: 'COMPLETED',
    });

    await expect(
      recreateLobbyFromVoidedMatch({
        actorDiscordId: 'mod-1',
        memberRoleIds: ['mod-role'],
        matchModRoleId: 'mod-role',
        sourceMatchId: 'voided-1',
        discordChannelId: 'chan-2',
      }),
    ).rejects.toThrow(MatchServiceError);

    expect(createPendingMatch).not.toHaveBeenCalled();
  });

  it('creates a pending lobby from a voided roster', async () => {
    getMatchById.mockResolvedValueOnce(VOIDED_MATCH).mockResolvedValueOnce({
      ...VOIDED_MATCH,
      id: 'new-1',
      status: 'PENDING',
      completedAt: null,
    });
    createPendingMatch.mockResolvedValue({
      matchId: 'new-1',
      createdAt: new Date('2026-08-23T11:00:00Z'),
      teamACount: 1,
      teamBCount: 0,
      playerCount: 1,
    });

    const result = await recreateLobbyFromVoidedMatch({
      actorDiscordId: 'mod-1',
      memberRoleIds: ['mod-role'],
      matchModRoleId: 'mod-role',
      sourceMatchId: 'voided-1',
      discordChannelId: 'chan-2',
    });

    expect(assertHasMatchModRole).toHaveBeenCalled();
    expect(createPendingMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        leagueId: 'league-1',
        hostDiscordId: 'host-1',
        discordChannelId: 'chan-2',
        players: [{ nick: 'goku', slot: 1 }],
      }),
    );
    expect(result.matchId).toBe('new-1');
    expect(result.sourceMatchId).toBe('voided-1');
    expect(result.hostDiscordId).toBe('host-1');
  });
});
