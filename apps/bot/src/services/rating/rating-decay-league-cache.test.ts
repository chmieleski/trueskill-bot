import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DECAY_LEAGUE_CACHE_TTL_MS,
  getDecayLeagueCached,
  invalidateDecayLeagueCache,
  type DecayLeagueCacheRow,
} from './rating-decay-league-cache.js';

describe('decay league cache', () => {
  beforeEach(() => {
    invalidateDecayLeagueCache('all');
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const row = (id: string): DecayLeagueCacheRow => ({
    status: 'ACTIVE',
    decayEnabled: true,
    seasonEndsAt: null,
    crunchStartedAt: null,
    archivedAt: null,
    decayMidGraceDays: null,
    decayMidTier1Ki: null,
    decayMidTier2Ki: null,
    decayMidTier1SpanDays: null,
    decayMidStreakCapKi: null,
    decayCrunchGraceDays: null,
    decayCrunchTier1Ki: null,
    decayCrunchTier2Ki: null,
    decayCrunchTier1SpanDays: null,
    decayCrunchWindowDays: null,
    decayPrizeLockEnabled: null,
    decayPrizeLockMinGames: null,
  });

  it('fetches once then serves from cache', async () => {
    const fetch = vi.fn(async () => row('league-1'));
    const a = await getDecayLeagueCached('league-1', fetch);
    const b = await getDecayLeagueCached('league-1', fetch);
    expect(a).toEqual(row('league-1'));
    expect(b).toEqual(row('league-1'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refetches after invalidate', async () => {
    const fetch = vi.fn(async () => row('league-1'));
    await getDecayLeagueCached('league-1', fetch);
    invalidateDecayLeagueCache('league-1');
    await getDecayLeagueCached('league-1', fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refetches after TTL', async () => {
    const fetch = vi.fn(async () => row('league-1'));
    await getDecayLeagueCached('league-1', fetch);
    vi.advanceTimersByTime(DECAY_LEAGUE_CACHE_TTL_MS + 1);
    await getDecayLeagueCached('league-1', fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('caches null miss briefly (no league)', async () => {
    const fetch = vi.fn(async () => null);
    await getDecayLeagueCached('missing', fetch);
    await getDecayLeagueCached('missing', fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
