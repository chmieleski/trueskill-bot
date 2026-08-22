import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadMatchDisplayStatsByPlayer, playerRatingFindMany } = vi.hoisted(() => ({
  loadMatchDisplayStatsByPlayer: vi.fn(),
  playerRatingFindMany: vi.fn(),
}));

vi.mock('../rating/rank-reset-display.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rating/rank-reset-display.js')>();
  return {
    ...actual,
    loadMatchDisplayStatsByPlayer,
  };
});

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    playerRating: { findMany: playerRatingFindMany },
  },
}));

import {
  collectNewPlayerSuggestions,
  collectNewPlayerSuggestionsForPendingCreate,
} from '../rating/new-player.js';

function statsMap(
  entries: Array<[string, number]>,
): Map<string, { wins: number; losses: number; games: number }> {
  return new Map(entries.map(([playerId, games]) => [playerId, { wins: 0, losses: games, games }]));
}

describe('collectNewPlayerSuggestions', () => {
  beforeEach(() => {
    loadMatchDisplayStatsByPlayer.mockReset();
    playerRatingFindMany.mockReset();
    playerRatingFindMany.mockResolvedValue([]);
  });

  it('suggests a newly seated player with 0 completed games', async () => {
    loadMatchDisplayStatsByPlayer.mockResolvedValue(statsMap([['p-new', 0]]));

    const suggestions = await collectNewPlayerSuggestions({
      leagueId: 'league-1',
      matchId: 'match-1',
      previousPlayerIds: new Set(['p-old']),
      nextPlayers: [
        { playerId: 'p-old', username: 'veteran' },
        { playerId: 'p-new', username: 'rookie' },
      ],
    });

    expect(suggestions).toEqual([
      {
        playerId: 'p-new',
        username: 'rookie',
        leagueId: 'league-1',
        matchId: 'match-1',
      },
    ]);
    expect(loadMatchDisplayStatsByPlayer).toHaveBeenCalledWith(
      'league-1',
      ['p-new'],
      expect.anything(),
    );
  });

  it('skips newly seated players who already have a completed game', async () => {
    loadMatchDisplayStatsByPlayer.mockResolvedValue(statsMap([['p-new', 1]]));

    const suggestions = await collectNewPlayerSuggestions({
      leagueId: 'league-1',
      matchId: 'match-1',
      previousPlayerIds: new Set(),
      nextPlayers: [{ playerId: 'p-new', username: 'rookie' }],
    });

    expect(suggestions).toBeUndefined();
  });

  it('skips players already flagged as New', async () => {
    loadMatchDisplayStatsByPlayer.mockResolvedValue(statsMap([['p-new', 0]]));
    playerRatingFindMany.mockResolvedValue([{ playerId: 'p-new', isNewPlayer: true }]);

    const suggestions = await collectNewPlayerSuggestions({
      leagueId: 'league-1',
      matchId: 'match-1',
      previousPlayerIds: new Set(),
      nextPlayers: [{ playerId: 'p-new', username: 'rookie' }],
    });

    expect(suggestions).toBeUndefined();
  });

  it('returns undefined when the roster has no newly seated players', async () => {
    const suggestions = await collectNewPlayerSuggestions({
      leagueId: 'league-1',
      matchId: 'match-1',
      previousPlayerIds: new Set(['p-old']),
      nextPlayers: [{ playerId: 'p-old', username: 'veteran' }],
    });

    expect(suggestions).toBeUndefined();
    expect(loadMatchDisplayStatsByPlayer).not.toHaveBeenCalled();
  });

  it('dedupes one suggestion per playerId', async () => {
    loadMatchDisplayStatsByPlayer.mockResolvedValue(statsMap([['p-new', 0]]));

    const suggestions = await collectNewPlayerSuggestions({
      leagueId: 'league-1',
      matchId: 'match-1',
      previousPlayerIds: new Set(),
      nextPlayers: [
        { playerId: 'p-new', username: 'rookie' },
        { playerId: 'p-new', username: 'rookie-dup' },
      ],
    });

    expect(suggestions).toEqual([
      {
        playerId: 'p-new',
        username: 'rookie',
        leagueId: 'league-1',
        matchId: 'match-1',
      },
    ]);
  });
});

describe('collectNewPlayerSuggestionsForPendingCreate', () => {
  beforeEach(() => {
    loadMatchDisplayStatsByPlayer.mockReset();
    playerRatingFindMany.mockReset();
    playerRatingFindMany.mockResolvedValue([]);
  });

  it('returns [] for an empty create roster', async () => {
    await expect(
      collectNewPlayerSuggestionsForPendingCreate({
        leagueId: 'league-1',
        matchId: 'match-1',
        players: [],
      }),
    ).resolves.toEqual([]);
    expect(loadMatchDisplayStatsByPlayer).not.toHaveBeenCalled();
  });

  it('suggests first-timers on PENDING create with empty previous set', async () => {
    loadMatchDisplayStatsByPlayer.mockResolvedValue(
      statsMap([
        ['p-new', 0],
        ['p-vet', 3],
      ]),
    );

    const suggestions = await collectNewPlayerSuggestionsForPendingCreate({
      leagueId: 'league-1',
      matchId: 'match-1',
      players: [
        { playerId: 'p-new', username: 'rookie' },
        { playerId: 'p-vet', username: 'veteran' },
      ],
    });

    expect(suggestions).toEqual([
      {
        playerId: 'p-new',
        username: 'rookie',
        leagueId: 'league-1',
        matchId: 'match-1',
      },
    ]);
    expect(loadMatchDisplayStatsByPlayer).toHaveBeenCalledWith(
      'league-1',
      ['p-new', 'p-vet'],
      expect.anything(),
    );
  });

  it('returns [] when create roster has no eligible first-timers', async () => {
    loadMatchDisplayStatsByPlayer.mockResolvedValue(statsMap([['p-vet', 2]]));

    await expect(
      collectNewPlayerSuggestionsForPendingCreate({
        leagueId: 'league-1',
        matchId: 'match-1',
        players: [{ playerId: 'p-vet', username: 'veteran' }],
      }),
    ).resolves.toEqual([]);
  });
});
