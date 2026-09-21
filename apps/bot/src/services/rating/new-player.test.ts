import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KI_Z_BLEND_GAMES } from './rating-math.js';

const {
  leagueFindUnique,
  playerRatingFindUnique,
  playerRatingUpdate,
  playerRatingCreateMany,
  playerHeroRatingCreateMany,
} = vi.hoisted(() => ({
  leagueFindUnique: vi.fn(),
  playerRatingFindUnique: vi.fn(),
  playerRatingUpdate: vi.fn(),
  playerRatingCreateMany: vi.fn(),
  playerHeroRatingCreateMany: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique: leagueFindUnique },
    playerRating: {
      findUnique: playerRatingFindUnique,
      update: playerRatingUpdate,
      createMany: playerRatingCreateMany,
    },
    playerHeroRating: { createMany: playerHeroRatingCreateMany },
  },
}));

import {
  parseNewPlayerButtonCustomId,
  buildNewPlayerConfirmCustomId,
  buildNewPlayerDeclineCustomId,
  playerIdsToClearNewFlag,
  shouldClearNewPlayer,
  shouldSuggestNewPlayer,
  setPlayerNewFlag,
  clearPlayerNewFlag,
} from './new-player.js';

describe('shouldSuggestNewPlayer', () => {
  it('suggests only at 0 games when not already new', () => {
    expect(shouldSuggestNewPlayer(0, false)).toBe(true);
    expect(shouldSuggestNewPlayer(0, true)).toBe(false);
    expect(shouldSuggestNewPlayer(1, false)).toBe(false);
  });

  it('skips when the player has games in a prior guild season', () => {
    expect(shouldSuggestNewPlayer(0, false, 1)).toBe(false);
    expect(shouldSuggestNewPlayer(0, false, 12)).toBe(false);
  });

  it('suggests when current and prior seasons are both at 0 games', () => {
    expect(shouldSuggestNewPlayer(0, false, 0)).toBe(true);
  });
});

describe('shouldClearNewPlayer', () => {
  it('clears at the calibrating threshold', () => {
    expect(shouldClearNewPlayer(KI_Z_BLEND_GAMES - 1)).toBe(false);
    expect(shouldClearNewPlayer(KI_Z_BLEND_GAMES)).toBe(true);
  });
});

describe('playerIdsToClearNewFlag', () => {
  it('clears isNewPlayer when after-match games >= 5', () => {
    const gamesByPlayer = new Map([
      ['a', KI_Z_BLEND_GAMES - 1],
      ['b', KI_Z_BLEND_GAMES],
      ['c', KI_Z_BLEND_GAMES + 2],
    ]);

    expect(playerIdsToClearNewFlag(['a', 'b', 'c', 'missing'], gamesByPlayer)).toEqual(['b', 'c']);
  });
});

describe('new player button custom ids', () => {
  // Realistic Discord id budget: 25-char cuid + 32-char compact uuid + 19-digit snowflake.
  const matchId = 'clxxxxxxxxxxxxxxxxxxxxxxx'; // 25
  const playerId = '550e8400-e29b-41d4-a716-446655440000';
  const compactPlayerId = '550e8400e29b41d4a716446655440000';
  const actorDiscordId = '1234567890123456789'; // 19

  it('round-trips confirm with compacted player UUID and no leagueId', () => {
    const id = buildNewPlayerConfirmCustomId(matchId, playerId, actorDiscordId);
    expect(id).toBe(`np:c:${matchId}:${compactPlayerId}:${actorDiscordId}`);
    expect(parseNewPlayerButtonCustomId(id)).toEqual({
      action: 'confirm',
      matchId,
      playerId,
      actorDiscordId,
    });
  });

  it('round-trips decline', () => {
    const id = buildNewPlayerDeclineCustomId(matchId, playerId, actorDiscordId);
    expect(id).toBe(`np:d:${matchId}:${compactPlayerId}:${actorDiscordId}`);
    expect(parseNewPlayerButtonCustomId(id)).toEqual({
      action: 'decline',
      matchId,
      playerId,
      actorDiscordId,
    });
  });

  it('keeps realistic confirm/decline customIds under Discord 100-char limit', () => {
    const confirmId = buildNewPlayerConfirmCustomId(matchId, playerId, actorDiscordId);
    const declineId = buildNewPlayerDeclineCustomId(matchId, playerId, actorDiscordId);
    expect(confirmId.length).toBeLessThanOrEqual(100);
    expect(declineId.length).toBeLessThanOrEqual(100);
  });

  it('rejects malformed ids', () => {
    expect(parseNewPlayerButtonCustomId('np:invalid')).toBeNull();
    expect(parseNewPlayerButtonCustomId(`np:c:${matchId}:${compactPlayerId}`)).toBeNull();
    expect(
      parseNewPlayerButtonCustomId(`np:confirm:${matchId}:${compactPlayerId}:${actorDiscordId}`),
    ).toBeNull();
  });
});

describe('setPlayerNewFlag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    leagueFindUnique.mockResolvedValue({ status: 'ACTIVE' });
    playerRatingCreateMany.mockResolvedValue({ count: 1 });
    playerHeroRatingCreateMany.mockResolvedValue({ count: 0 });
    playerRatingUpdate.mockResolvedValue({});
  });

  it('sets isNewPlayer when currently false', async () => {
    playerRatingFindUnique.mockResolvedValue({ isNewPlayer: false });
    await expect(
      setPlayerNewFlag({ leagueId: 'L', playerId: 'P', username: 'rookie' }),
    ).resolves.toEqual({ status: 'set', username: 'rookie' });
    expect(playerRatingUpdate).toHaveBeenCalledWith({
      where: { leagueId_playerId: { leagueId: 'L', playerId: 'P' } },
      data: { isNewPlayer: true },
    });
  });

  it('returns already_new when flag is true', async () => {
    playerRatingFindUnique.mockResolvedValue({ isNewPlayer: true });
    await expect(
      setPlayerNewFlag({ leagueId: 'L', playerId: 'P', username: 'rookie' }),
    ).resolves.toEqual({ status: 'already_new', username: 'rookie' });
    expect(playerRatingUpdate).not.toHaveBeenCalled();
  });
});

describe('clearPlayerNewFlag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    leagueFindUnique.mockResolvedValue({ status: 'ACTIVE' });
    playerRatingUpdate.mockResolvedValue({});
  });

  it('clears when currently true', async () => {
    playerRatingFindUnique.mockResolvedValue({ isNewPlayer: true });
    await expect(
      clearPlayerNewFlag({ leagueId: 'L', playerId: 'P', username: 'rookie' }),
    ).resolves.toEqual({ status: 'cleared', username: 'rookie' });
    expect(playerRatingUpdate).toHaveBeenCalledWith({
      where: { leagueId_playerId: { leagueId: 'L', playerId: 'P' } },
      data: { isNewPlayer: false },
    });
  });

  it('returns not_new when missing row or false', async () => {
    playerRatingFindUnique.mockResolvedValue(null);
    await expect(
      clearPlayerNewFlag({ leagueId: 'L', playerId: 'P', username: 'rookie' }),
    ).resolves.toEqual({ status: 'not_new', username: 'rookie' });
    expect(playerRatingUpdate).not.toHaveBeenCalled();
  });
});
