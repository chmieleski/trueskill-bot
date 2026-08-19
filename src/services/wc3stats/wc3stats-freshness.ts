/**
 * wc3stats detail may include when its roster snapshot was last observed.
 * Refresh is allowed only when that timestamp is newer than manual/screenshot edits.
 */

const WC3STATS_STALE_MESSAGE =
  'wc3stats roster is older than your screenshot or manual edits. Your current roster was kept.';
const WC3STATS_NO_OBSERVED_AT_MESSAGE =
  'wc3stats has not published a fresh player list since your screenshot or manual edits. Your current roster was kept.';

export { WC3STATS_NO_OBSERVED_AT_MESSAGE, WC3STATS_STALE_MESSAGE };

/** Parse rosterObservedAt from wc3stats detail (ISO-8601 string or unix seconds/ms). */
export function parseWc3statsRosterObservedAt(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return null;
    }

    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

/**
 * True when wc3stats may replace the Discord roster.
 * No manual authority yet → allow. Otherwise rosterObservedAt must be strictly newer.
 */
export function isWc3statsRosterFresh(input: {
  rosterObservedAt: Date | null;
  lobbyRosterAuthorityAt: Date | null;
}): boolean {
  if (!input.lobbyRosterAuthorityAt) {
    return true;
  }

  if (!input.rosterObservedAt) {
    return false;
  }

  return input.rosterObservedAt.getTime() > input.lobbyRosterAuthorityAt.getTime();
}

export function wc3statsStaleRefreshMessage(input: {
  rosterObservedAt: Date | null;
  lobbyRosterAuthorityAt: Date | null;
}): string {
  if (!input.lobbyRosterAuthorityAt) {
    return WC3STATS_STALE_MESSAGE;
  }

  return input.rosterObservedAt ? WC3STATS_STALE_MESSAGE : WC3STATS_NO_OBSERVED_AT_MESSAGE;
}
