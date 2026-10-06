import { describe, expect, it } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_WOS_GAME_ID, WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';
import {
  addPlayer,
  movePlayer,
  nextEmptySlotOnTeam,
  parseTeamInput,
  swapPlayers,
} from './roster.js';
import { MatchServiceError } from '../match/match-service.js';

const wos = getGameProfile(WARCRAFT3_WOS_GAME_ID);
const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);

describe('addPlayer slot range', () => {
  it('rejects slot 11 on WOS with locked copy', () => {
    expect(() => addPlayer([], 'n', 11, wos)).toThrow(MatchServiceError);
    expect(() => addPlayer([], 'n', 11, wos)).toThrow('Invalid slot. This game uses slots 1–10.');
  });

  it('accepts slot 12 on UDBR', () => {
    expect(addPlayer([], 'n', 12, udbr)).toEqual([{ slot: 12, nick: 'n' }]);
  });
});

describe('parseTeamInput', () => {
  it('accepts 1/2, a/b, and profile team names', () => {
    expect(parseTeamInput('1', wos)).toBe(1);
    expect(parseTeamInput('b', wos)).toBe(2);
    expect(parseTeamInput('Team A', wos)).toBe(1);
    expect(parseTeamInput('team b', wos)).toBe(2);
  });

  it('rejects unknown team text', () => {
    expect(() => parseTeamInput('mid', wos)).toThrow(MatchServiceError);
    expect(() => parseTeamInput('mid', wos)).toThrow(
      /Enter 1 \(WOS Enjoyers\) or 2 \(WOS Haters\)/,
    );
  });
});

describe('nextEmptySlotOnTeam', () => {
  it('picks the lowest empty seat on the team', () => {
    expect(nextEmptySlotOnTeam([], wos, 1)).toBe(1);
    expect(nextEmptySlotOnTeam([{ slot: 1, nick: 'a' }], wos, 1)).toBe(2);
    expect(nextEmptySlotOnTeam([], wos, 2)).toBe(6);
  });

  it('throws when the team is full', () => {
    const fullA = [1, 2, 3, 4, 5].map((slot) => ({ slot, nick: `n${slot}` }));
    expect(() => nextEmptySlotOnTeam(fullA, wos, 1)).toThrow('WOS Enjoyers is full.');
  });
});

describe('movePlayer clears soft lock', () => {
  it('drops locked when a player changes slot', () => {
    const roster = [
      { slot: 1, nick: 'a', locked: true },
      { slot: 7, nick: 'b', locked: true },
    ];
    expect(movePlayer(roster, 1, 2, udbr)).toEqual([
      { slot: 2, nick: 'a', locked: false },
      { slot: 7, nick: 'b', locked: true },
    ]);
  });

  it('clears locks on both seats when swapping', () => {
    const roster = [
      { slot: 1, nick: 'a', locked: true },
      { slot: 7, nick: 'b', locked: true },
    ];
    expect(swapPlayers(roster, 1, 7, udbr)).toEqual([
      { slot: 7, nick: 'a', locked: false },
      { slot: 1, nick: 'b', locked: false },
    ]);
  });
});
