import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadMatchDisplayStatsByPlayer } = vi.hoisted(() => ({
  loadMatchDisplayStatsByPlayer: vi.fn(),
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
    matchRatingSnapshot: { findMany: vi.fn() },
    matchPlayer: {
      groupBy: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import {
  ratingPreviewFromStoredMatchPlayers,
  resolveCompletedRatingPreview,
} from './match-history-preview.js';
import type { MatchWithPlayers } from './match-service.js';

function storedMatchFixture(): MatchWithPlayers {
  return {
    id: 'm1',
    leagueId: 'L1',
    status: 'COMPLETED',
    completedAt: new Date('2026-08-10T00:00:00.000Z'),
    createdAt: new Date('2026-08-10T00:00:00.000Z'),
    hostId: 'host',
    players: [
      {
        playerId: 'P1',
        team: 1,
        result: 'WIN',
        slot: 3,
        heroId: 3,
        isQuitter: false,
        globalKi: 4100,
        globalKiDelta: 80,
        heroKi: 4050,
        heroKiDelta: 40,
        player: { username: 'alice' },
      },
      {
        playerId: 'P2',
        team: 2,
        result: 'LOSS',
        slot: 8,
        heroId: 8,
        isQuitter: false,
        globalKi: 3900,
        globalKiDelta: -60,
        heroKi: 3880,
        heroKiDelta: -30,
        player: { username: 'bob' },
      },
    ],
  } as MatchWithPlayers;
}

describe('ratingPreviewFromStoredMatchPlayers', () => {
  it('attaches leagueGames from the display-stats map', () => {
    const leagueGamesByPlayer = new Map([
      ['P1', 2],
      ['P2', 4],
    ]);

    const preview = ratingPreviewFromStoredMatchPlayers(
      storedMatchFixture(),
      leagueGamesByPlayer,
    );

    expect(preview?.players).toEqual([
      expect.objectContaining({ slot: 3, leagueGames: 2 }),
      expect.objectContaining({ slot: 8, leagueGames: 4 }),
    ]);
  });
});

describe('resolveCompletedRatingPreview', () => {
  beforeEach(() => {
    loadMatchDisplayStatsByPlayer.mockReset();
  });

  it('loads reset-aware after-match games for the calibrating gate', async () => {
    loadMatchDisplayStatsByPlayer.mockResolvedValue(
      new Map([
        ['P1', { games: 2, wins: 2, losses: 0, quits: 0 }],
        ['P2', { games: 2, wins: 0, losses: 2, quits: 0 }],
      ]),
    );

    const preview = await resolveCompletedRatingPreview(storedMatchFixture());

    expect(loadMatchDisplayStatsByPlayer).toHaveBeenCalledWith('L1', ['P1', 'P2']);
    expect(preview?.players).toEqual([
      expect.objectContaining({ slot: 3, leagueGames: 2 }),
      expect.objectContaining({ slot: 8, leagueGames: 2 }),
    ]);
  });
});
