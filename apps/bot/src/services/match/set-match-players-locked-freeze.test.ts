import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';
import { FROZEN_LOBBY_MESSAGE } from '../lobby-draft/draft-types.js';

const { matchFindUnique, lobbyDraftFindFirst, matchPlayerUpdate, prismaTransaction, profile } =
  vi.hoisted(() => ({
    matchFindUnique: vi.fn(),
    lobbyDraftFindFirst: vi.fn(),
    matchPlayerUpdate: vi.fn(),
    prismaTransaction: vi.fn(),
    profile: vi.fn(),
  }));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    match: { findUnique: matchFindUnique },
    lobbyDraft: { findFirst: lobbyDraftFindFirst },
    matchPlayer: { update: matchPlayerUpdate },
    $transaction: prismaTransaction,
  },
}));

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../league/league-profile.js', () => ({
  getGameProfileForLeague: profile,
  LeagueNotFoundError: class LeagueNotFoundError extends Error {},
}));

import { setMatchPlayersLocked } from './match-service.js';

describe('setMatchPlayersLocked draft freeze', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    profile.mockResolvedValue(getGameProfile(WARCRAFT3_WOS_GAME_ID));
    matchFindUnique.mockResolvedValue({
      id: 'match-1',
      status: 'PENDING',
      leagueId: 'league-1',
      eventId: null,
      players: [{ slot: 1, playerId: 'p-a' }],
    });
  });

  it('rejects lock toggles while a draft is active', async () => {
    lobbyDraftFindFirst.mockResolvedValue({ id: 'draft-1' });
    await expect(setMatchPlayersLocked('match-1', [{ slot: 1, mode: 'slot' }])).rejects.toThrow(
      FROZEN_LOBBY_MESSAGE,
    );
    expect(prismaTransaction).not.toHaveBeenCalled();
    expect(matchPlayerUpdate).not.toHaveBeenCalled();
  });
});
