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
import {
  loadPlayerGlobalDeltaForMatch,
  rebuildCompletedRatingPreview,
} from './match-history-preview.js';

export const MATCH_HISTORY_PAGE_SIZE = 10;

export type MatchHistoryRow = {
  matchId: string;
  completedAt: Date;
  result: 'WIN' | 'LOSS';
  team: 1 | 2;
  heroName: string | null;
  isQuitter: boolean;
  /** Global ki delta for the history target when snapshots exist. */
  globalDelta?: number;
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

/** Compact result cell: W / L, with Q when the player quit. */
export function formatMatchHistoryResult(
  row: Pick<MatchHistoryRow, 'result' | 'isQuitter'>,
): string {
  const base = row.result === 'WIN' ? 'W' : 'L';
  return row.isQuitter ? `${base}Q` : base;
}

/**
 * Monospace history table (same pattern as leaderboard embeds).
 * Columns: Date, R (W/L/WQ/LQ), Δki, Team, Hero, Match id.
 */
export function formatMatchHistoryTable(
  rows: Array<{ row: MatchHistoryRow; teamLabel: string }>,
): string {
  if (rows.length === 0) {
    return '_No completed matches yet._';
  }

  const dates = rows.map(({ row }) => formatHistoryDate(row.completedAt));
  const results = rows.map(({ row }) => formatMatchHistoryResult(row));
  const deltas = rows.map(({ row }) => formatMatchHistoryDelta(row.globalDelta));
  const teams = rows.map(({ teamLabel }) => teamLabel);
  const heroes = rows.map(({ row }) => row.heroName ?? '—');
  const ids = rows.map(({ row }) => row.matchId);

  const dateW = Math.max(...dates.map((value) => value.length), 'Date'.length);
  const resW = Math.max(...results.map((value) => value.length), 'R'.length);
  const deltaW = Math.max(...deltas.map((value) => value.length), 'Δki'.length);
  const teamW = Math.max(...teams.map((value) => value.length), 'Team'.length);
  const heroW = Math.max(...heroes.map((value) => value.length), 'Hero'.length);

  const header = [
    'Date'.padEnd(dateW),
    'R'.padEnd(resW),
    'Δki'.padStart(deltaW),
    'Team'.padEnd(teamW),
    'Hero'.padEnd(heroW),
    'Match id',
  ].join('  ');

  const lines = rows.map((_, index) =>
    [
      dates[index]!.padEnd(dateW),
      results[index]!.padEnd(resW),
      deltas[index]!.padStart(deltaW),
      teams[index]!.padEnd(teamW),
      heroes[index]!.padEnd(heroW),
      ids[index]!,
    ].join('  '),
  );

  return `\`\`\`\n${header}\n${lines.join('\n')}\n\`\`\``;
}

/** Compact signed ki delta for table cells. */
export function formatMatchHistoryDelta(delta: number | undefined): string {
  if (delta === undefined) {
    return '—';
  }
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta}`;
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
    include: {
      players: {
        include: { player: true },
        orderBy: { slot: 'asc' },
      },
    },
  });

  const catalog = await loadHeroCatalog();
  const heroNameById = new Map(catalog.map((h) => [h.id, h.name]));

  const rows: MatchHistoryRow[] = [];
  for (const match of matches) {
    const mp = match.players.find((player) => player.playerId === input.playerId);
    if (!mp || (mp.result !== 'WIN' && mp.result !== 'LOSS')) {
      continue;
    }
    if (mp.team !== 1 && mp.team !== 2) {
      continue;
    }
    const globalDelta = await loadPlayerGlobalDeltaForMatch(
      match as MatchWithPlayers,
      input.playerId,
    );
    rows.push({
      matchId: match.id,
      completedAt: match.completedAt ?? match.createdAt,
      result: mp.result,
      team: mp.team,
      heroName: mp.heroId != null ? (heroNameById.get(mp.heroId) ?? null) : null,
      isQuitter: mp.isQuitter,
      globalDelta,
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
  const table = formatMatchHistoryTable(
    page.rows.map((row) => ({ row, teamLabel: teamLabelFor(row.team) })),
  );

  const embed = new EmbedBuilder()
    .setTitle(`Match history — ${page.targetUsername}`)
    .setDescription(
      `Page ${page.page} of ${page.totalPages} · ${page.totalMatches} matches\n\n${table}`,
    )
    .setColor(0xf0b232);

  if (page.totalPages > 1) {
    embed.setFooter({
      text: 'Copy Match id → /match show · Only you can use the buttons',
    });
  } else if (page.totalMatches > 0) {
    embed.setFooter({ text: 'Copy Match id → /match show match_id:…' });
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
  const ratingPreview = await rebuildCompletedRatingPreview(match);
  const embed = buildMatchCompletedEmbed(match.id, matchToLobbyPlayers(match), {
    winningTeam,
    profile,
    ...(ratingPreview ? { ratingPreview } : {}),
  });

  return { match, embed };
}
