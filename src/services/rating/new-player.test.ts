import { describe, expect, it } from 'vitest';
import { KI_Z_BLEND_GAMES } from './rating-math.js';
import {
  parseNewPlayerButtonCustomId,
  buildNewPlayerConfirmCustomId,
  buildNewPlayerDeclineCustomId,
  playerIdsToClearNewFlag,
  shouldClearNewPlayer,
  shouldSuggestNewPlayer,
} from './new-player.js';

describe('shouldSuggestNewPlayer', () => {
  it('suggests only at 0 games when not already new', () => {
    expect(shouldSuggestNewPlayer(0, false)).toBe(true);
    expect(shouldSuggestNewPlayer(0, true)).toBe(false);
    expect(shouldSuggestNewPlayer(1, false)).toBe(false);
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
