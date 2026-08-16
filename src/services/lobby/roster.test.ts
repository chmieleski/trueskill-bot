import { describe, expect, it } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import {
  WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID,
  WARCRAFT3_UDBR_GAME_ID,
} from '../../domain/games.js';
import { addPlayer } from './roster.js';
import { MatchServiceError } from '../match/match-service.js';

const aca = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);
const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);

describe('addPlayer slot range', () => {
  it('rejects slot 11 on ACA with locked copy', () => {
    expect(() => addPlayer([], 'n', 11, aca)).toThrow(MatchServiceError);
    expect(() => addPlayer([], 'n', 11, aca)).toThrow(
      'Invalid slot. This game uses slots 1–10.',
    );
  });

  it('accepts slot 12 on UDBR', () => {
    expect(addPlayer([], 'n', 12, udbr)).toEqual([{ slot: 12, nick: 'n' }]);
  });
});
