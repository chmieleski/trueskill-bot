import { describe, expect, it } from 'vitest';
import {
  WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID,
  WARCRAFT3_UDBR_GAME_ID,
} from './games.js';
import {
  getGameProfile,
  invalidSlotMessage,
  isSlotInProfile,
  rosterHeroId,
  teamForSlot,
  UnknownGameIdError,
} from './game-profile.js';

describe('getGameProfile', () => {
  it('returns UDBR 12-slot slot_bound wc3stats profile', () => {
    const profile = getGameProfile(WARCRAFT3_UDBR_GAME_ID);
    expect(profile.slotCount).toBe(12);
    expect(profile.teamAMaxSlot).toBe(6);
    expect(profile.heroBinding).toBe('slot_bound');
    expect(profile.import).toBe('wc3stats');
    expect(profile.teamNames).toEqual({ 1: 'Z Fighters', 2: 'Evil' });
  });

  it('returns ACA 10-slot optional_in_game none profile', () => {
    const profile = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);
    expect(profile.gameId).toBe('warcraft3_anime_choice_arena');
    expect(profile.displayName).toBe('Anime Choice Arena');
    expect(profile.slotCount).toBe(10);
    expect(profile.teamAMaxSlot).toBe(5);
    expect(profile.heroBinding).toBe('optional_in_game');
    expect(profile.import).toBe('none');
    expect(profile.teamNames).toEqual({ 1: 'Team A', 2: 'Team B' });
  });

  it('throws UnknownGameIdError for unknown ids', () => {
    expect(() => getGameProfile('valorant_custom')).toThrow(UnknownGameIdError);
  });
});

describe('teamForSlot / rosterHeroId', () => {
  const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);
  const aca = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);

  it('splits UDBR 1-6 / 7-12 and ACA 1-5 / 6-10', () => {
    expect(teamForSlot(udbr, 6)).toBe(1);
    expect(teamForSlot(udbr, 7)).toBe(2);
    expect(teamForSlot(aca, 5)).toBe(1);
    expect(teamForSlot(aca, 6)).toBe(2);
  });

  it('returns slot as heroId only when slot_bound', () => {
    expect(rosterHeroId(udbr, 3)).toBe(3);
    expect(rosterHeroId(aca, 3)).toBeNull();
  });

  it('rejects slot 11 on ACA and accepts slot 12 on UDBR', () => {
    expect(isSlotInProfile(aca, 11)).toBe(false);
    expect(isSlotInProfile(udbr, 12)).toBe(true);
    expect(invalidSlotMessage(aca)).toBe('Invalid slot. This game uses slots 1–10.');
  });
});
