const BATTLE_TAG_SUFFIX = /^(.*)#\d+$/;

/**
 * Canonical in-game nick: trim, strip optional Battle.net `#1234` suffix, lowercase.
 * All Player create/lookup paths must run nicks through this before hitting the DB.
 */
export function normalizeNick(nick: string): string {
  const trimmed = nick.trim();
  const stripped = BATTLE_TAG_SUFFIX.exec(trimmed)?.[1] ?? trimmed;
  return stripped.toLowerCase();
}
