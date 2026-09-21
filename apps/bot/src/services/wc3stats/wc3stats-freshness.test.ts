import { describe, expect, it } from 'vitest';
import {
  isWc3statsRosterFresh,
  parseWc3statsRosterObservedAt,
  wc3statsStaleRefreshMessage,
  WC3STATS_NO_OBSERVED_AT_MESSAGE,
  WC3STATS_STALE_MESSAGE,
} from './wc3stats-freshness.js';

describe('parseWc3statsRosterObservedAt', () => {
  it('parses ISO-8601 strings', () => {
    const parsed = parseWc3statsRosterObservedAt('2026-08-19T20:00:00.000Z');
    expect(parsed?.toISOString()).toBe('2026-08-19T20:00:00.000Z');
  });

  it('parses unix seconds', () => {
    const parsed = parseWc3statsRosterObservedAt(1_755_638_400);
    expect(parsed?.getTime()).toBe(1_755_638_400_000);
  });

  it('returns null for empty or invalid values', () => {
    expect(parseWc3statsRosterObservedAt(null)).toBeNull();
    expect(parseWc3statsRosterObservedAt('')).toBeNull();
    expect(parseWc3statsRosterObservedAt('not-a-date')).toBeNull();
  });
});

describe('isWc3statsRosterFresh', () => {
  const authority = new Date('2026-08-19T20:00:00.000Z');

  it('allows refresh when there is no manual authority timestamp', () => {
    expect(
      isWc3statsRosterFresh({
        rosterObservedAt: new Date('2026-08-19T19:00:00.000Z'),
        lobbyRosterAuthorityAt: null,
      }),
    ).toBe(true);
  });

  it('allows refresh when wc3stats observed after authority', () => {
    expect(
      isWc3statsRosterFresh({
        rosterObservedAt: new Date('2026-08-19T21:00:00.000Z'),
        lobbyRosterAuthorityAt: authority,
      }),
    ).toBe(true);
  });

  it('blocks refresh when wc3stats observed at or before authority', () => {
    expect(
      isWc3statsRosterFresh({
        rosterObservedAt: authority,
        lobbyRosterAuthorityAt: authority,
      }),
    ).toBe(false);

    expect(
      isWc3statsRosterFresh({
        rosterObservedAt: new Date('2026-08-19T19:00:00.000Z'),
        lobbyRosterAuthorityAt: authority,
      }),
    ).toBe(false);
  });

  it('blocks refresh when authority exists but wc3stats has no observed time', () => {
    expect(
      isWc3statsRosterFresh({
        rosterObservedAt: null,
        lobbyRosterAuthorityAt: authority,
      }),
    ).toBe(false);
  });
});

describe('wc3statsStaleRefreshMessage', () => {
  it('uses the no-observed-at copy when wc3stats omitted rosterObservedAt', () => {
    expect(
      wc3statsStaleRefreshMessage({
        rosterObservedAt: null,
        lobbyRosterAuthorityAt: new Date(),
      }),
    ).toBe(WC3STATS_NO_OBSERVED_AT_MESSAGE);
  });

  it('uses the stale copy when wc3stats observedAt is older', () => {
    expect(
      wc3statsStaleRefreshMessage({
        rosterObservedAt: new Date('2026-08-19T19:00:00.000Z'),
        lobbyRosterAuthorityAt: new Date('2026-08-19T20:00:00.000Z'),
      }),
    ).toBe(WC3STATS_STALE_MESSAGE);
  });
});
