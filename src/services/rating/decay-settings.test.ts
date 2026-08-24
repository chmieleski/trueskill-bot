import { describe, expect, it } from 'vitest';
import {
  assertDecaySettingBounds,
  DEFAULT_DECAY_SETTINGS,
  resolveDecaySettings,
  tier1EndIdleDay,
} from './decay-settings.js';

describe('resolveDecaySettings', () => {
  it('returns code defaults when league is null', () => {
    expect(resolveDecaySettings(null)).toEqual(DEFAULT_DECAY_SETTINGS);
  });

  it('merges null overrides with defaults', () => {
    expect(
      resolveDecaySettings({
        decayMidGraceDays: null,
        decayMidTier1Ki: 75,
        decayPrizeLockEnabled: false,
      }),
    ).toEqual({
      ...DEFAULT_DECAY_SETTINGS,
      midTier1Ki: 75,
      prizeLockEnabled: false,
    });
  });

  it('defaults prizeLockMinGames to 1', () => {
    expect(resolveDecaySettings(null).prizeLockMinGames).toBe(1);
    expect(resolveDecaySettings({}).prizeLockMinGames).toBe(1);
  });

  it('uses league override for prizeLockMinGames', () => {
    expect(resolveDecaySettings({ decayPrizeLockMinGames: 7 }).prizeLockMinGames).toBe(7);
  });
});

describe('assertDecaySettingBounds', () => {
  it('accepts valid grace days', () => {
    expect(assertDecaySettingBounds('midGraceDays', 14)).toBe(14);
  });

  it('rejects out-of-range grace days', () => {
    expect(() => assertDecaySettingBounds('midGraceDays', 91)).toThrow(
      'Days must be between 0 and 90.',
    );
  });

  it('rejects crunch window of 0', () => {
    expect(() => assertDecaySettingBounds('crunchWindowDays', 0)).toThrow(
      'Crunch window must be between 1 and 90 days.',
    );
  });

  it('allows streak cap of 0 (no cap)', () => {
    expect(assertDecaySettingBounds('midStreakCapKi', 0)).toBe(0);
  });

  it('rejects non-integer ki rates', () => {
    expect(() => assertDecaySettingBounds('midTier1Ki', 1.5)).toThrow(
      'Value must be a whole number.',
    );
  });

  it('rejects prizeLockMinGames out of bounds', () => {
    expect(() => assertDecaySettingBounds('prizeLockMinGames', 0)).toThrow(/between 1 and 50/);
    expect(() => assertDecaySettingBounds('prizeLockMinGames', 51)).toThrow(/between 1 and 50/);
    expect(assertDecaySettingBounds('prizeLockMinGames', 7)).toBe(7);
  });
});

describe('tier1EndIdleDay', () => {
  it('matches default mid-season boundary (grace 10 + span 9 = day 19)', () => {
    expect(tier1EndIdleDay(10, 9)).toBe(19);
  });
});
