import { describe, expect, it } from 'vitest';
import { KI_Z_BLEND_GAMES } from './rating-math.js';
import {
  parseNewPlayerButtonCustomId,
  buildNewPlayerConfirmCustomId,
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

describe('new player button custom ids', () => {
  it('round-trips confirm', () => {
    const id = buildNewPlayerConfirmCustomId('m1', 'l1', 'p1', 'd1');
    expect(parseNewPlayerButtonCustomId(id)).toEqual({
      action: 'confirm',
      matchId: 'm1',
      leagueId: 'l1',
      playerId: 'p1',
      actorDiscordId: 'd1',
    });
  });
});
