import { describe, expect, it } from 'vitest';
import { parseApiHeroStatsQuery } from './parse-query.js';

describe('parseApiHeroStatsQuery', () => {
  it('defaults to both / games 20 / recentLimit 20 / topPlayers 5', () => {
    const result = parseApiHeroStatsQuery(new URLSearchParams());
    expect(result).toEqual({
      ok: true,
      value: {
        scope: 'both',
        games: 20,
        from: null,
        to: null,
        recentLimit: 20,
        topPlayers: 5,
      },
    });
  });

  it('rejects unknown scope', () => {
    const result = parseApiHeroStatsQuery(new URLSearchParams('scope=week'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/scope/i);
    }
  });

  it('requires from when scope=range', () => {
    const result = parseApiHeroStatsQuery(new URLSearchParams('scope=range'));
    expect(result.ok).toBe(false);
  });

  it('parses range from/to ISO dates', () => {
    const result = parseApiHeroStatsQuery(
      new URLSearchParams('scope=range&from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.from?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(result.value.to?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    }
  });

  it('rejects from >= to', () => {
    const result = parseApiHeroStatsQuery(
      new URLSearchParams('scope=range&from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z'),
    );
    expect(result.ok).toBe(false);
  });

  it('clamps games to 1–100', () => {
    expect(parseApiHeroStatsQuery(new URLSearchParams('games=0')).ok).toBe(false);
    expect(parseApiHeroStatsQuery(new URLSearchParams('games=101')).ok).toBe(false);
    const ok = parseApiHeroStatsQuery(new URLSearchParams('scope=last&games=50'));
    expect(ok).toMatchObject({ ok: true, value: { games: 50, scope: 'last' } });
  });

  it('rejects from/to when scope is not range', () => {
    const result = parseApiHeroStatsQuery(
      new URLSearchParams('scope=all&from=2026-01-01T00:00:00.000Z'),
    );
    expect(result.ok).toBe(false);
  });
});
