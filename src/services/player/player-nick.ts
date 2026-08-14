/**
 * Canonical in-game nick: trim + lowercase.
 * All Player create/lookup paths must run nicks through this before hitting the DB.
 */
export function normalizeNick(nick: string): string {
  return nick.trim().toLowerCase();
}
