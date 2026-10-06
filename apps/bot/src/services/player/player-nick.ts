const BATTLE_TAG_SUFFIX = /^(.*)#\d+$/;

/** In-game display nick: trim and strip optional Battle.net `#1234`; case kept. */
export function stripBattleTag(nick: string): string {
  const trimmed = nick.trim();
  return BATTLE_TAG_SUFFIX.exec(trimmed)?.[1] ?? trimmed;
}

/**
 * Canonical in-game nick: trim, strip optional Battle.net `#1234` suffix, lowercase.
 * All Player create/lookup paths must run nicks through this before hitting the DB.
 */
export function normalizeNick(nick: string): string {
  return stripBattleTag(nick).toLowerCase();
}
