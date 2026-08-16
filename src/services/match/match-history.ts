export const MATCH_HISTORY_PAGE_SIZE = 10;

export type MatchHistoryRow = {
  matchId: string;
  completedAt: Date;
  result: 'WIN' | 'LOSS';
  team: 1 | 2;
  heroName: string | null;
  isQuitter: boolean;
};

export type MatchHistoryPage = {
  targetPlayerId: string;
  targetUsername: string;
  page: number;
  totalPages: number;
  totalMatches: number;
  rows: MatchHistoryRow[];
};

/** UTC calendar date YYYY-MM-DD for history rows. */
function formatHistoryDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatMatchHistoryRow(row: MatchHistoryRow, teamLabel: string): string {
  const wl = row.result === 'WIN' ? 'W' : 'L';
  const hero = row.heroName ?? '—';
  const quit = row.isQuitter ? ' Q' : '';
  return `\`${row.matchId}\` · ${formatHistoryDate(row.completedAt)} · ${wl} · ${teamLabel} · ${hero}${quit}`;
}

export function clampMatchHistoryPage(page: number, totalPages: number): number {
  const safeTotal = Math.max(1, totalPages);
  if (!Number.isFinite(page) || page < 1) return 1;
  if (page > safeTotal) return safeTotal;
  return page;
}

export function winningTeamFromPlayers(
  players: Array<{ team: number; result: string | null }>,
): 1 | 2 {
  return players.some((player) => player.result === 'WIN' && player.team === 1) ? 1 : 2;
}

/** Prefix short enough for Discord customId max 100 with two cuids + snowflake. */
export function buildMatchHistoryPageCustomId(
  invokerId: string,
  playerId: string,
  leagueId: string,
  direction: 'prev' | 'next',
  currentPage: number,
): string {
  return `mh:p:${invokerId}:${playerId}:${leagueId}:${direction}:${currentPage}`;
}

export function parseMatchHistoryPageCustomId(
  customId: string,
): { invokerId: string; playerId: string; leagueId: string; page: number } | null {
  const parts = customId.split(':');
  // mh:p:invoker:player:league:dir:page → 7 parts
  if (parts.length !== 7 || parts[0] !== 'mh' || parts[1] !== 'p') {
    return null;
  }
  const direction = parts[5];
  const currentPage = Number.parseInt(parts[6]!, 10);
  if (!Number.isFinite(currentPage) || currentPage < 1) {
    return null;
  }
  const invokerId = parts[2]!;
  const playerId = parts[3]!;
  const leagueId = parts[4]!;
  if (!invokerId || !playerId || !leagueId) {
    return null;
  }
  if (direction === 'prev') {
    return { invokerId, playerId, leagueId, page: currentPage - 1 };
  }
  if (direction === 'next') {
    return { invokerId, playerId, leagueId, page: currentPage + 1 };
  }
  return null;
}
