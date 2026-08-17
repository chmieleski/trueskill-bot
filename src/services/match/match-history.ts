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
  resolveCompletedRatingPreview,
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

/** Compact result cell: W / L, with Q when the player quit. */
export function formatMatchHistoryResult(
  row: Pick<MatchHistoryRow, 'result' | 'isQuitter'>,
): string {
  const base = row.result === 'WIN' ? 'W' : 'L';
  return row.isQuitter ? `${base}Q` : base;
}

/** Compact signed ki delta for display. */
export function formatMatchHistoryDelta(delta: number | undefined): string {
  if (delta === undefined) {
    return '—';
  }
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta}`;
}

/**
 * One Discord embed field per match.
 * Name = what you scan (hero + Δ); value = outcome, team, date, copyable id.
 */
export function formatMatchHistoryField(
  row: MatchHistoryRow,
  teamLabel: string,
): { name: string; value: string; inline: boolean } {
  const emoji = row.result === 'WIN' ? '✅' : '❌';
  const outcome = row.result === 'WIN' ? 'Win' : 'Loss';
  const hero = row.heroName ?? 'Unknown hero';
  const delta = formatMatchHistoryDelta(row.globalDelta);
  const unix = Math.floor(row.completedAt.getTime() / 1000);
  const quit = row.isQuitter ? ' · Quit' : '';

  return {
    name: `${hero} · ${emoji} ${delta} ki`,
    value: `${outcome}${quit} · ${teamLabel} · <t:${unix}:D>\n\`${row.matchId}\``,
    inline: false,
  };
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

const UUID_HYPHENATED =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_COMPACT = /^[0-9a-f]{32}$/i;

/** Strip UUID hyphens so two 36-char ids + snowflake fit Discord's 100-char customId. */
function compactHistoryId(id: string): string {
  return UUID_HYPHENATED.test(id) ? id.replace(/-/g, '') : id;
}

/** Restore hyphenated UUID form for Prisma lookups. */
function expandHistoryId(id: string): string {
  if (!UUID_COMPACT.test(id)) {
    return id;
  }
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** Discord customId max 100. Player ids are UUIDs; some league ids are too (legacy). */
export function buildMatchHistoryPageCustomId(
  invokerId: string,
  playerId: string,
  leagueId: string,
  direction: 'prev' | 'next',
  currentPage: number,
): string {
  const dirToken = direction === 'prev' ? 'p' : 'n';
  return `mh:p:${invokerId}:${compactHistoryId(playerId)}:${compactHistoryId(leagueId)}:${dirToken}:${currentPage}`;
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
  const playerId = expandHistoryId(parts[3]!);
  const leagueId = expandHistoryId(parts[4]!);
  if (!invokerId || !playerId || !leagueId) {
    return null;
  }
  if (direction === 'prev' || direction === 'p') {
    return { invokerId, playerId, leagueId, page: currentPage - 1 };
  }
  if (direction === 'next' || direction === 'n') {
    return { invokerId, playerId, leagueId, page: currentPage + 1 };
  }
  return null;
}

export async function resolveHistoryPlayer(
  gameId: string,
  discordId: string,
  kind: 'self' | 'user',
): Promise<{ id: string; username: string }> {
  const player = await prisma.player.findUnique({
    where: { gameId_discordId: { gameId, discordId } },
  });
  if (!player) {
    if (kind === 'self') {
      throw new MatchServiceError(
        "Your Discord is not linked to an in-game nick for this league's game. Use /link to bind it.",
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
    // Null completedAt (legacy rows) must not float above newer completed matches.
    orderBy: [{ completedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
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
  const embed = new EmbedBuilder()
    .setColor(0xf0b232)
    .setAuthor({ name: page.targetUsername })
    .setTitle('Match history')
    .setDescription(`Page **${page.page}** of **${page.totalPages}** · ${page.totalMatches} matches`);

  if (page.rows.length === 0) {
    embed.addFields({
      name: 'Matches',
      value: '_No completed matches yet._',
    });
  } else {
    embed.addFields(
      ...page.rows.map((row) => formatMatchHistoryField(row, teamLabelFor(row.team))),
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
  const ratingPreview = await resolveCompletedRatingPreview(match);
  const embed = buildMatchCompletedEmbed(match.id, matchToLobbyPlayers(match), {
    winningTeam,
    profile,
    timestamp: match.completedAt ?? match.createdAt,
    ...(ratingPreview ? { ratingPreview } : {}),
  });

  return { match, embed };
}
