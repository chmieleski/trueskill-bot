import { test, expect, describe } from 'vitest';
import { bytesToMb, isEventLoopAboveWarn, isRssAboveWarn, nsToMs } from './thresholds.js';

describe('thresholds', () => {
  test('isRssAboveWarn', () => {
    expect(isRssAboveWarn(512, 512)).toBe(true);
    expect(isRssAboveWarn(511, 512)).toBe(false);
  });

  test('isEventLoopAboveWarn', () => {
    expect(isEventLoopAboveWarn(200, 200)).toBe(true);
    expect(isEventLoopAboveWarn(199, 200)).toBe(false);
  });

  test('bytesToMb and nsToMs', () => {
    expect(bytesToMb(2 * 1024 * 1024)).toBe(2);
    expect(nsToMs(50_000_000)).toBe(50);
  });
});
