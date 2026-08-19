import { compactUuidForCustomId, expandUuidFromCustomId } from './compact-custom-id.js';

export const MATCH_LIST_PAGE_SIZE = 10;

export type MatchListRow = {
  matchId: string;
  completedAt: Date;
  winningTeam: 1 | 2;
  format: string;
};

/** Team-1 vs team-2 human counts, e.g. `4v6`. */
export function formatMatchListFormat(team1Count: number, team2Count: number): string {
  return `${team1Count}v${team2Count}`;
}

/** Count MatchPlayer rows on team 1 and 2. Ignore any other team value. */
export function countMatchListTeamSizes(
  players: Array<{ team: number }>,
): { team1: number; team2: number } {
  let team1 = 0;
  let team2 = 0;
  for (const player of players) {
    if (player.team === 1) team1 += 1;
    else if (player.team === 2) team2 += 1;
  }
  return { team1, team2 };
}

/** One Discord embed field per match: winner + format / date + copyable id. */
export function formatMatchListField(
  row: MatchListRow,
  winnerLabel: string,
): { name: string; value: string; inline: boolean } {
  const unix = Math.floor(row.completedAt.getTime() / 1000);
  return {
    name: `${winnerLabel} · ${row.format}`,
    value: `<t:${unix}:D>\n\`${row.matchId}\``,
    inline: false,
  };
}

export function buildMatchListPageCustomId(
  invokerId: string,
  leagueId: string,
  direction: 'prev' | 'next',
  currentPage: number,
): string {
  const dirToken = direction === 'prev' ? 'p' : 'n';
  return `ml:p:${invokerId}:${compactUuidForCustomId(leagueId)}:${dirToken}:${currentPage}`;
}

export function parseMatchListPageCustomId(
  customId: string,
): { invokerId: string; leagueId: string; page: number } | null {
  const parts = customId.split(':');
  // ml:p:invoker:league:dir:page → 6 parts
  if (parts.length !== 6 || parts[0] !== 'ml' || parts[1] !== 'p') {
    return null;
  }
  const direction = parts[4];
  const currentPage = Number.parseInt(parts[5]!, 10);
  if (!Number.isFinite(currentPage) || currentPage < 1) {
    return null;
  }
  const invokerId = parts[2]!;
  const leagueId = expandUuidFromCustomId(parts[3]!);
  if (!invokerId || !leagueId) {
    return null;
  }
  if (direction === 'prev' || direction === 'p') {
    return { invokerId, leagueId, page: currentPage - 1 };
  }
  if (direction === 'next' || direction === 'n') {
    return { invokerId, leagueId, page: currentPage + 1 };
  }
  return null;
}
