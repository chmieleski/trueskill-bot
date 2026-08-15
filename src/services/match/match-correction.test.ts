import { describe, expect, it } from 'vitest';
import { CORRECTION_WINDOW_MS, GLOBAL_SNAPSHOT_HERO_ID } from './match-correction.js';

describe('match correction constants', () => {
  it('uses a 24h window', () => {
    expect(CORRECTION_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('uses heroId sentinel 0 for GLOBAL rows', () => {
    expect(GLOBAL_SNAPSHOT_HERO_ID).toBe(0);
  });
});

