import { describe, expect, it } from 'vitest';
import { WARCRAFT3_WOS_GAME_ID, WARCRAFT3_UDBR_GAME_ID } from './games.js';
import {
  assertTeam,
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
    expect(profile.postMatchStats).toBe('none');
    expect(profile.ratingLabel).toBe('ki');
    expect(profile.teamNames).toEqual({ 1: 'Z Fighters', 2: 'Evil' });
    expect(profile.sideWinLossDefault).toBe(true);
  });

  it('returns WOS 10-slot optional_in_game wc3stats profile with post-match stats', () => {
    const profile = getGameProfile(WARCRAFT3_WOS_GAME_ID);
    expect(profile.gameId).toBe('warcraft3_wos');
    expect(profile.displayName).toBe('WOS');
    expect(profile.slotCount).toBe(10);
    expect(profile.teamAMaxSlot).toBe(5);
    expect(profile.heroBinding).toBe('optional_in_game');
    expect(profile.import).toBe('wc3stats');
    expect(profile.postMatchStats).toBe('wos2_bot_v1');
    expect(profile.ratingLabel).toBe('sp');
    expect(profile.teamNames).toEqual({ 1: 'WOS Enjoyers', 2: 'WOS Haters' });
    expect(profile.sideWinLossDefault).toBe(false);
  });

  it('throws UnknownGameIdError for unknown ids', () => {
    expect(() => getGameProfile('valorant_custom')).toThrow(UnknownGameIdError);
  });

  it('returns frozen profile objects so callers cannot mutate the catalog', () => {
    const profile = getGameProfile(WARCRAFT3_UDBR_GAME_ID);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.teamNames)).toBe(true);
    expect(() => {
      (profile as { slotCount: number }).slotCount = 99;
    }).toThrow();
  });
});

describe('assertTeam', () => {
  it('accepts 1 and 2', () => {
    expect(assertTeam(1)).toBe(1);
    expect(assertTeam(2)).toBe(2);
  });

  it('rejects other values', () => {
    expect(() => assertTeam(0)).toThrow(RangeError);
    expect(() => assertTeam(3)).toThrow(RangeError);
  });
});

describe('teamForSlot / rosterHeroId', () => {
  const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);
  const wos = getGameProfile(WARCRAFT3_WOS_GAME_ID);

  it('splits UDBR 1-6 / 7-12 and WOS 1-5 / 6-10', () => {
    expect(teamForSlot(udbr, 6)).toBe(1);
    expect(teamForSlot(udbr, 7)).toBe(2);
    expect(teamForSlot(wos, 5)).toBe(1);
    expect(teamForSlot(wos, 6)).toBe(2);
  });

  it('returns slot as heroId only when slot_bound', () => {
    expect(rosterHeroId(udbr, 3)).toBe(3);
    expect(rosterHeroId(wos, 3)).toBeNull();
  });

  it('rejects slot 11 on WOS and accepts slot 12 on UDBR', () => {
    expect(isSlotInProfile(wos, 11)).toBe(false);
    expect(isSlotInProfile(udbr, 12)).toBe(true);
    expect(invalidSlotMessage(wos)).toBe('Invalid slot. This game uses slots 1–10.');
  });
});
