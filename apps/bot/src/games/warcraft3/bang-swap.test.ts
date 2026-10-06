import { describe, expect, it } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID, WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';
import { formatBangSwap, wc3InGameSlot } from './bang-swap.js';

const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);
const wos = getGameProfile(WARCRAFT3_WOS_GAME_ID);

describe('formatBangSwap', () => {
  it('formats name then slot', () => {
    expect(formatBangSwap('Goku', 6)).toBe('!swap Goku 6');
  });
});

describe('wc3InGameSlot', () => {
  it('uses the UDBR preset when the league has no map (bot 5 → 6, bot 7 → 5)', () => {
    expect(wc3InGameSlot(udbr, null, 1)).toBe(1);
    expect(wc3InGameSlot(udbr, null, 5)).toBe(6);
    expect(wc3InGameSlot(udbr, null, 7)).toBe(5);
    expect(wc3InGameSlot(udbr, null, 12)).toBe(12);
  });

  it('prefers the league slot map (wc3stats index + 1)', () => {
    const leagueMap = new Map([[9, 1]]); // wc3stats index 9 → bot slot 1
    expect(wc3InGameSlot(udbr, leagueMap, 1)).toBe(10);
  });

  it('falls back to the preset when the league map lacks that bot slot', () => {
    const leagueMap = new Map([[9, 1]]);
    expect(wc3InGameSlot(udbr, leagueMap, 7)).toBe(5);
  });

  it('uses the WOS preset for WOS', () => {
    expect(wc3InGameSlot(wos, null, 1)).toBe(1);
  });
});
