import { describe, expect, it } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import {
  WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID,
  WARCRAFT3_UDBR_GAME_ID,
} from '../../domain/games.js';
import { addPlayer, nextEmptySlotOnTeam, parseTeamInput } from './roster.js';
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

describe('parseTeamInput', () => {
  it('accepts 1/2, a/b, and profile team names', () => {
    expect(parseTeamInput('1', aca)).toBe(1);
    expect(parseTeamInput('b', aca)).toBe(2);
    expect(parseTeamInput('Team A', aca)).toBe(1);
    expect(parseTeamInput('team b', aca)).toBe(2);
  });

  it('rejects unknown team text', () => {
    expect(() => parseTeamInput('mid', aca)).toThrow(MatchServiceError);
    expect(() => parseTeamInput('mid', aca)).toThrow(/Enter 1 \(Team A\) or 2 \(Team B\)/);
  });
});

describe('nextEmptySlotOnTeam', () => {
  it('picks the lowest empty seat on the team', () => {
    expect(nextEmptySlotOnTeam([], aca, 1)).toBe(1);
    expect(nextEmptySlotOnTeam([{ slot: 1, nick: 'a' }], aca, 1)).toBe(2);
    expect(nextEmptySlotOnTeam([], aca, 2)).toBe(6);
  });

  it('throws when the team is full', () => {
    const fullA = [1, 2, 3, 4, 5].map((slot) => ({ slot, nick: `n${slot}` }));
    expect(() => nextEmptySlotOnTeam(fullA, aca, 1)).toThrow('Team A is full.');
  });
});
