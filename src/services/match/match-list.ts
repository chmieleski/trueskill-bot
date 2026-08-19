import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { prisma } from '../../lib/prisma.js';
import { getLeagueById } from '../league/league.js';
import { compactUuidForCustomId, expandUuidFromCustomId } from './compact-custom-id.js';
import { clampMatchHistoryPage, winningTeamFromPlayers } from './match-history.js';
import { MatchServiceError } from './match-service.js';

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
export function countMatchListTeamSizes(players: Array<{ team: number }>): {
  team1: number;
  team2: number;
} {
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

export type MatchListPage = {
  leagueName: string;
  page: number;
  totalPages: number;
  totalMatches: number;
  rows: MatchListRow[];
};

export async function loadMatchListPage(input: {
  leagueId: string;
  page: number;
}): Promise<MatchListPage> {
  const league = await getLeagueById(input.leagueId);
  if (!league) {
    throw new MatchServiceError('This league was not found.');
  }

  const where = {
    leagueId: input.leagueId,
    status: 'COMPLETED' as const,
  };

  const totalMatches = await prisma.match.count({ where });
  const totalPages = Math.max(1, Math.ceil(totalMatches / MATCH_LIST_PAGE_SIZE));
  const page = clampMatchHistoryPage(input.page, totalPages);
  const skip = (page - 1) * MATCH_LIST_PAGE_SIZE;

  const matches = await prisma.match.findMany({
    where,
    orderBy: [{ completedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    skip,
    take: MATCH_LIST_PAGE_SIZE,
    include: {
      players: {
        select: { team: true, result: true },
      },
    },
  });

  const rows: MatchListRow[] = matches.map((match) => {
    const sizes = countMatchListTeamSizes(match.players);
    return {
      matchId: match.id,
      completedAt: match.completedAt ?? match.createdAt,
      winningTeam: winningTeamFromPlayers(match.players),
      format: formatMatchListFormat(sizes.team1, sizes.team2),
    };
  });

  return {
    leagueName: league.name,
    page,
    totalPages,
    totalMatches,
    rows,
  };
}

export function buildMatchListEmbed(
  page: MatchListPage,
  teamLabelFor: (team: 1 | 2) => string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xf0b232)
    .setAuthor({ name: page.leagueName })
    .setTitle('Match list')
    .setDescription(
      `Page **${page.page}** of **${page.totalPages}** · ${page.totalMatches} matches`,
    );

  if (page.rows.length === 0) {
    embed.addFields({
      name: 'Matches',
      value: '_No completed matches yet._',
    });
  } else {
    embed.addFields(
      ...page.rows.map((row) => formatMatchListField(row, teamLabelFor(row.winningTeam))),
    );
  }

  if (page.totalPages > 1) {
    embed.setFooter({
      text: 'Tap an id → /match show · Only you can use the buttons',
    });
  } else if (page.totalMatches > 0) {
    embed.setFooter({ text: 'Copy an id → /match show match_id:…' });
  }

  return embed;
}

export function buildMatchListPageButtons(input: {
  invokerId: string;
  leagueId: string;
  page: number;
  totalPages: number;
}): ActionRowBuilder<ButtonBuilder>[] {
  if (input.totalPages <= 1) {
    return [];
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildMatchListPageCustomId(input.invokerId, input.leagueId, 'prev', input.page))
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page <= 1),
    new ButtonBuilder()
      .setCustomId(buildMatchListPageCustomId(input.invokerId, input.leagueId, 'next', input.page))
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page >= input.totalPages),
  );
  return [row];
}
