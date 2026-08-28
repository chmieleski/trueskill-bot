import { describe, expect, it } from 'vitest';
import { MatchServiceError } from '../match/match-service.js';
import { compileWc3statsMapConfig, isWc3statsMap } from './wc3stats-map.js';
import {
  assertUniqueHeroTargets,
  formatWc3statsSlotMapLines,
  parseWc3statsMapSha1,
  parseWc3statsSlotMapEntries,
  toWc3statsHeroSlotMap,
  UDBR_MAP_PATTERN,
  UDBR_MAP_SHA1,
  UDBR_WC3STATS_SLOT_MAP,
  WOS_MAP_PATTERN,
  WOS_MAP_SHA1,
  WOS_WC3STATS_SLOT_MAP,
} from './wc3stats-slot-map.js';

describe('parseWc3statsSlotMapEntries', () => {
  it('parses comma-separated wc3=hero pairs', () => {
    expect(parseWc3statsSlotMapEntries('0=1,4=7,1=2')).toEqual([
      { wc3statsSlot: 0, heroId: 1 },
      { wc3statsSlot: 1, heroId: 2 },
      { wc3statsSlot: 4, heroId: 7 },
    ]);
  });

  it('accepts colon separators', () => {
    expect(parseWc3statsSlotMapEntries('0:1;4:7')).toEqual([
      { wc3statsSlot: 0, heroId: 1 },
      { wc3statsSlot: 4, heroId: 7 },
    ]);
  });

  it('rejects duplicate hero targets', () => {
    expect(() => parseWc3statsSlotMapEntries('0=1,4=1')).toThrow(MatchServiceError);
  });

  it('rejects out-of-range hero slots', () => {
    expect(() => parseWc3statsSlotMapEntries('0=13')).toThrow(MatchServiceError);
  });
});

describe('UDBR_WC3STATS_SLOT_MAP', () => {
  it('maps twelve unique heroes and leaves referee indices free', () => {
    assertUniqueHeroTargets([...UDBR_WC3STATS_SLOT_MAP]);
    const map = toWc3statsHeroSlotMap(UDBR_WC3STATS_SLOT_MAP);
    expect(map.size).toBe(12);
    expect(map.get(0)).toBe(1);
    expect(map.get(4)).toBe(7);
    expect(map.get(5)).toBe(5);
    expect(map.has(12)).toBe(false);
  });
});

describe('formatWc3statsSlotMapLines', () => {
  it('explains unset legacy behavior', () => {
    expect(formatWc3statsSlotMapLines([])[0]).toContain('legacy');
  });
});

describe('parseWc3statsMapSha1', () => {
  it('returns empty for null/undefined/blank', () => {
    expect(parseWc3statsMapSha1(null)).toEqual([]);
    expect(parseWc3statsMapSha1(undefined)).toEqual([]);
    expect(parseWc3statsMapSha1('  ')).toEqual([]);
  });

  it('splits, trims, and lowercases', () => {
    expect(parseWc3statsMapSha1('ABC, def ,')).toEqual(['abc', 'def']);
  });
});

describe('WOS_WC3STATS_SLOT_MAP', () => {
  it('maps ten sequential player colors to slots 1–10', () => {
    assertUniqueHeroTargets([...WOS_WC3STATS_SLOT_MAP]);
    const map = toWc3statsHeroSlotMap(WOS_WC3STATS_SLOT_MAP);
    expect(map.size).toBe(10);
    expect(map.get(0)).toBe(1);
    expect(map.get(4)).toBe(5);
    expect(map.get(5)).toBe(6);
    expect(map.get(9)).toBe(10);
    expect(map.has(10)).toBe(false);
  });
});

describe('WOS filter constants', () => {
  it('matches Anime_WOS2_0.30 from wc3stats', () => {
    expect(WOS_MAP_SHA1).toBe('ee61b21fca7333db0531c8eee5e33b1acafd61ed');
    const config = compileWc3statsMapConfig(WOS_MAP_PATTERN, parseWc3statsMapSha1(WOS_MAP_SHA1));
    expect(isWc3statsMap({ map: 'Anime_WOS2_0.30.w3x' }, config)).toBe(true);
    expect(
      isWc3statsMap(
        {
          normalizedName: 'Anime_WOS2_0.30',
          path: 'Maps/Download/Anime_WOS2_0.30.w3x',
          sha1: WOS_MAP_SHA1,
        },
        config,
      ),
    ).toBe(true);
    expect(isWc3statsMap({ map: 'UltimateDragonBallReborn.w3x' }, config)).toBe(false);
  });
});

describe('UDBR filter constants', () => {
  it('matches the historical env defaults', () => {
    expect(UDBR_MAP_PATTERN).toBe('ultimate.?dragon.?ball.?reborn|udbr');
    expect(UDBR_MAP_SHA1).toBe('19783c6259e86253a8c940ede63a87e18204bd94');
  });
});
