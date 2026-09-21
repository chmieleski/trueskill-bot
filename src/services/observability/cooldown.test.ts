import { test, expect, describe } from 'vitest';
import { AlertCooldown } from './cooldown.js';

describe('AlertCooldown', () => {
  test('high_rss is blocked within cooldown window', () => {
    const cooldown = new AlertCooldown(10_000);
    expect(cooldown.tryAllow('high_rss', 1_000)).toBe(true);
    expect(cooldown.tryAllow('high_rss', 5_000)).toBe(false);
    expect(cooldown.tryAllow('high_rss', 12_000)).toBe(true);
  });

  test('crash always allowed', () => {
    const cooldown = new AlertCooldown(10_000);
    expect(cooldown.tryAllow('crash', 1_000)).toBe(true);
    expect(cooldown.tryAllow('crash', 1_100)).toBe(true);
  });
});
