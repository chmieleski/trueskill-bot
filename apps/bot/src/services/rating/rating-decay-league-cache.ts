import type { LeagueStatus } from '@dbz/db';
import { DECAY_SETTINGS_SELECT } from './decay-settings.js';

/** Backstop TTL when a writer forgets to invalidate (ms). */
export const DECAY_LEAGUE_CACHE_TTL_MS = 60_000;

export type DecayLeagueCacheRow = {
  status: LeagueStatus;
  decayEnabled: boolean;
  seasonEndsAt: Date | null;
  crunchStartedAt: Date | null;
  archivedAt: Date | null;
} & {
  [K in keyof typeof DECAY_SETTINGS_SELECT]: number | boolean | null;
};

type CacheEntry = {
  value: DecayLeagueCacheRow | null;
  fetchedAtMs: number;
};

const cache = new Map<string, CacheEntry>();

export function invalidateDecayLeagueCache(leagueId: string | 'all'): void {
  if (leagueId === 'all') {
    cache.clear();
    return;
  }
  cache.delete(leagueId);
}

/**
 * Return cached League decay row, or fetch+store.
 * `fetch` should use the same select shape as applyPendingDecay.
 */
export async function getDecayLeagueCached(
  leagueId: string,
  fetch: () => Promise<DecayLeagueCacheRow | null>,
  nowMs: number = Date.now(),
): Promise<DecayLeagueCacheRow | null> {
  const hit = cache.get(leagueId);
  if (hit && nowMs - hit.fetchedAtMs < DECAY_LEAGUE_CACHE_TTL_MS) {
    return hit.value;
  }
  const value = await fetch();
  cache.set(leagueId, { value, fetchedAtMs: nowMs });
  return value;
}
