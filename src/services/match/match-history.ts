import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { prisma } from '../../lib/prisma.js';
import { loadHeroCatalog } from '../guild/hero-catalog.js';
import { listLeaguesForGuild } from '../league/league.js';
import { getGameProfileForLeague } from '../league/league-profile.js';
import { buildMatchCompletedEmbed } from '../lobby/lobby-preview.js';
import {
  getMatchById,
  matchToLobbyPlayers,
  MatchServiceError,
  type MatchWithPlayers,
} from './match-service.js';

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

export async function resolveHistoryPlayer(
  discordId: string,
  kind: 'self' | 'user',
): Promise<{ id: string; username: string }> {
  const player = await prisma.player.findUnique({ where: { discordId } });
  if (!player) {
    if (kind === 'self') {
      throw new MatchServiceError(
        'Your Discord is not linked to an in-game nick. Use /link to bind it.',
      );
    }
    throw new MatchServiceError('Player not found.');
  }
  return { id: player.id, username: player.username };
}

export async function loadMatchHistoryPage(input: {
  leagueId: string;
  playerId: string;
  username: string;
  page: number;
}): Promise<MatchHistoryPage> {
  const where = {
    leagueId: input.leagueId,
    status: 'COMPLETED' as const,
    players: { some: { playerId: input.playerId } },
  };

  const totalMatches = await prisma.match.count({ where });
  const totalPages = Math.max(1, Math.ceil(totalMatches / MATCH_HISTORY_PAGE_SIZE));
  const page = clampMatchHistoryPage(input.page, totalPages);
  const skip = (page - 1) * MATCH_HISTORY_PAGE_SIZE;

  const matches = await prisma.match.findMany({
    where,
    orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
    skip,
    take: MATCH_HISTORY_PAGE_SIZE,
    select: {
      id: true,
      completedAt: true,
      createdAt: true,
      players: {
        where: { playerId: input.playerId },
        select: {
          team: true,
          result: true,
          heroId: true,
          isQuitter: true,
        },
      },
    },
  });

  const catalog = await loadHeroCatalog();
  const heroNameById = new Map(catalog.map((h) => [h.id, h.name]));

  const rows: MatchHistoryRow[] = [];
  for (const match of matches) {
    const mp = match.players[0];
    if (!mp || (mp.result !== 'WIN' && mp.result !== 'LOSS')) {
      continue;
    }
    if (mp.team !== 1 && mp.team !== 2) {
      continue;
    }
    rows.push({
      matchId: match.id,
      completedAt: match.completedAt ?? match.createdAt,
      result: mp.result,
      team: mp.team,
      heroName: mp.heroId != null ? (heroNameById.get(mp.heroId) ?? null) : null,
      isQuitter: mp.isQuitter,
    });
  }

  return {
    targetPlayerId: input.playerId,
    targetUsername: input.username,
    page,
    totalPages,
    totalMatches,
    rows,
  };
}

export function buildMatchHistoryEmbed(
  page: MatchHistoryPage,
  _leagueId: string,
  teamLabelFor: (team: 1 | 2) => string,
): EmbedBuilder {
  const body =
    page.rows.length === 0
      ? 'No completed matches yet.'
      : page.rows.map((row) => formatMatchHistoryRow(row, teamLabelFor(row.team))).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`Match history — ${page.targetUsername}`)
    .setDescription(
      `Page ${page.page} of ${page.totalPages} · ${page.totalMatches} matches\n\n${body}`,
    )
    .setColor(0xf0b232);

  if (page.totalPages > 1) {
    embed.setFooter({
      text: 'Use /match show match_id:… · Only you can use the buttons',
    });
  } else if (page.totalMatches > 0) {
    embed.setFooter({ text: 'Use /match show match_id:… to open a match' });
  }

  return embed;
}

export function buildMatchHistoryPageButtons(input: {
  invokerId: string;
  playerId: string;
  leagueId: string;
  page: number;
  totalPages: number;
}): ActionRowBuilder<ButtonBuilder>[] {
  if (input.totalPages <= 1) {
    return [];
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        buildMatchHistoryPageCustomId(
          input.invokerId,
          input.playerId,
          input.leagueId,
          'prev',
          input.page,
        ),
      )
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page <= 1),
    new ButtonBuilder()
      .setCustomId(
        buildMatchHistoryPageCustomId(
          input.invokerId,
          input.playerId,
          input.leagueId,
          'next',
          input.page,
        ),
      )
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page >= input.totalPages),
  );
  return [row];
}

/** Load a completed match for /match show with guild/league tenancy checks. */
export async function loadCompletedMatchShow(input: {
  matchId: string;
  guildId: string;
  leagueId?: string | null;
}): Promise<{ match: MatchWithPlayers; embed: EmbedBuilder }> {
  const match = await getMatchById(input.matchId);
  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }

  const leagues = await listLeaguesForGuild(input.guildId);
  const allowed = new Set(leagues.map((league) => league.id));
  if (!allowed.has(match.leagueId)) {
    throw new MatchServiceError('This match was not found.');
  }

  if (input.leagueId && match.leagueId !== input.leagueId) {
    throw new MatchServiceError('This match was not found.');
  }

  if (match.status !== 'COMPLETED') {
    throw new MatchServiceError('This match is not completed.');
  }

  const profile = await getGameProfileForLeague(match.leagueId);
  const winningTeam = winningTeamFromPlayers(match.players);
  const embed = buildMatchCompletedEmbed(match.id, matchToLobbyPlayers(match), {
    winningTeam,
    profile,
  });

  return { match, embed };
}
