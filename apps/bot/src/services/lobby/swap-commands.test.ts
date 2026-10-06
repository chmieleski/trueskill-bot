import { describe, expect, it } from 'vitest';
import { getGameProfile, type GameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';
import { buildSwapCommandLines } from './swap-commands.js';

const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);

describe('buildSwapCommandLines', () => {
  it('maps bot slots to in-game slots and sorts by in-game slot', () => {
    const lines = buildSwapCommandLines({
      profile: udbr,
      target: [
        { slot: 5, nick: 'goku' },
        { slot: 7, nick: 'broly' },
      ],
      snapshot: [
        { slot: 7, nick: 'goku', rawName: 'Goku' },
        { slot: 5, nick: 'broly', rawName: 'Broly' },
      ],
      leagueSlotMap: null,
    });
    expect(lines).toEqual(['!swap Broly 5', '!swap Goku 6']);
  });

  it('returns no lines when the game has no swap command', () => {
    const noSwap: GameProfile = { ...udbr, lobbySwapCommand: 'none' };
    expect(
      buildSwapCommandLines({
        profile: noSwap,
        target: [{ slot: 1, nick: 'goku' }],
        snapshot: [],
        leagueSlotMap: null,
      }),
    ).toEqual([]);
  });
});
