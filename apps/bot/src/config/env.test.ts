import { describe, expect, it } from 'vitest';
import { parseDisplayStatsSource } from './env.js';

describe('parseDisplayStatsSource', () => {
  it('defaults to history when unset or unknown', () => {
    expect(parseDisplayStatsSource(undefined)).toBe('history');
    expect(parseDisplayStatsSource('')).toBe('history');
    expect(parseDisplayStatsSource('  ')).toBe('history');
    expect(parseDisplayStatsSource('bogus')).toBe('history');
    expect(parseDisplayStatsSource('HISTORY')).toBe('history');
  });

  it('accepts counters case-insensitively', () => {
    expect(parseDisplayStatsSource('counters')).toBe('counters');
    expect(parseDisplayStatsSource(' COUNTERS ')).toBe('counters');
  });
});
