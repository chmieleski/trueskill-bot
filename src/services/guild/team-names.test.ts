import { describe, expect, it } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import {
  WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID,
  WARCRAFT3_UDBR_GAME_ID,
} from '../../domain/games.js';
import { teamDisplayName, teamDisplayNameForSlot } from './team-names.js';

const aca = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);
const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);

describe('teamDisplayName', () => {
  it('maps team 1 to Z Fighters and team 2 to Evil', () => {
    expect(teamDisplayName(1)).toBe('Z Fighters');
    expect(teamDisplayName(2)).toBe('Evil');
  });

  it('uses profile teamNames when provided', () => {
    expect(teamDisplayName(1, aca)).toBe('Team A');
    expect(teamDisplayName(2, aca)).toBe('Team B');
    expect(teamDisplayNameForSlot(6, aca)).toBe('Team B');
  });

  it('keeps Z Fighters / Evil without a profile (slash + UDBR OCR)', () => {
    expect(teamDisplayName(1)).toBe('Z Fighters');
  });
});

describe('teamDisplayNameForSlot', () => {
  it('uses team 1 for slots 1-6 and team 2 for 7-12', () => {
    expect(teamDisplayNameForSlot(1, udbr)).toBe('Z Fighters');
    expect(teamDisplayNameForSlot(6, udbr)).toBe('Z Fighters');
    expect(teamDisplayNameForSlot(7, udbr)).toBe('Evil');
    expect(teamDisplayNameForSlot(12, udbr)).toBe('Evil');
  });
});
