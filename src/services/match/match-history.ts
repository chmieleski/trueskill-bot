import type { MatchStatus, Prisma } from '@prisma/client';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { prisma } from '../../lib/prisma.js';
import { formatHeroDisplayName, resolveHeroDisplayNames } from '../game/game-hero-catalog.js';
import { loadHeroCatalog } from '../guild/hero-catalog.js';
import { listLeaguesForGuild } from '../league/league.js';
import { CALIBRATING_LABEL, isCalibrating } from '../rating/rating-math.js';
import { buildMatchCompletedEmbed } from '../lobby/lobby-preview.js';
import {
  getGameProfileForMatch,
  getMatchById,
  matchToLobbyPlayers,
  MatchServiceError,
  requireLeagueId,
  type MatchWithPlayers,
} from './match-service.js';
import { formatMatchStatsFieldValue, loadMatchPlayerStatsLines } from './match-stats-upload.js';
import { compactUuidForCustomId, expandUuidFromCustomId } from './compact-custom-id.js';
import {
  countCompletedGamesThrough,
  loadLatestRankResetAtByPlayer,
} from '../rating/rank-reset-display.js';
import { findPlayerForRankLookup, type RankLookup } from '../player/player-profile.js';
import {
  loadPlayerGlobalDeltaForMatch,
  resolveCompletedRatingPreview,
} from './match-history-preview.js';

export const MATCH_HISTORY_PAGE_SIZE = 10;

export type MatchHistoryRow = {
  matchId: string;
  completedAt: Date;
  result: 'WIN' | 'LOSS' | 'CANCELLED';
  team: 1 | 2;
  heroName: string | null;
  isQuitter: boolean;
  isGriefer: boolean;
  /** Deferred season-end ki tax accrued when marked griefer. */
  grieferKiAccrued: number | null;
  /** Global ki delta for the history target when snapshots exist. */
  globalDelta?: number;
  /** After-match completed WIN/LOSS count for the Calibrating gate. */
  leagueGames: number;
};

export type MatchHistoryPage = {
  targetPlayerId: string;
  targetUsername: string;
  page: number;
  totalPages: number;
  totalMatches: number;
  griefersOnly: boolean;
  rows: MatchHistoryRow[];
};

/** Compact result cell: W / L / X (cancelled), with Q when the player quit. */
export function formatMatchHistoryResult(
  row: Pick<MatchHistoryRow, 'result' | 'isQuitter'>,
): string {
  if (row.result === 'CANCELLED') {
    return 'X';
  }
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
  const cancelled = row.result === 'CANCELLED';
  const emoji = cancelled ? '🚫' : row.result === 'WIN' ? '✅' : '❌';
  const outcome = cancelled ? 'Cancelled' : row.result === 'WIN' ? 'Win' : 'Loss';
  const hero = row.heroName ?? 'Unknown hero';
  const ratingBit = cancelled
    ? 'cancelled'
    : isCalibrating(row.leagueGames)
      ? CALIBRATING_LABEL
      : `${formatMatchHistoryDelta(row.globalDelta)} ki`;
  const unix = Math.floor(row.completedAt.getTime() / 1000);
  const quit = row.isQuitter ? ' · Quit' : '';
  const griefer =
    row.isGriefer && row.grieferKiAccrued != null && row.grieferKiAccrued > 0
      ? ` · Griefer (−${row.grieferKiAccrued} ki pool)`
      : row.isGriefer
        ? ' · Griefer'
        : '';

  const teamBit = teamLabel ? ` · ${teamLabel}` : '';

  return {
    name: `${hero} · ${emoji} ${ratingBit}`,
    value: `${outcome}${quit}${griefer}${teamBit} · <t:${unix}:D>\n\`${row.matchId}\``,
    inline: false,
  };
}

function matchEndedAt(match: { completedAt: Date | null; updatedAt: Date; createdAt: Date }): Date {
  return match.completedAt ?? match.updatedAt ?? match.createdAt;
}

type HistoryHeroSource = {
  heroId: number | null;
  stats: { heroName: string | null; heroObjectId: number | null } | null;
};

/** Prefer uploaded match stats (WOS); fall back to slot-bound Hero catalog (UDBR). */
export function resolveMatchHistoryHeroName(
  mp: HistoryHeroSource,
  heroNameById: Map<number, string>,
  gameHeroNames: Map<number, string>,
  gameId: string | null,
): string | null {
  const stats = mp.stats;
  if (gameId && stats && (stats.heroObjectId != null || stats.heroName?.trim())) {
    const fromStats = formatHeroDisplayName(stats.heroObjectId, gameHeroNames, stats.heroName);
    if (fromStats !== 'Unknown hero') {
      return fromStats;
    }
  }
  if (mp.heroId != null) {
    return heroNameById.get(mp.heroId) ?? null;
  }
  return null;
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

/** Discord customId max 100. Player ids are UUIDs; some league ids are too (legacy). */
export function buildMatchHistoryPageCustomId(
  invokerId: string,
  playerId: string,
  leagueId: string,
  direction: 'prev' | 'next',
  currentPage: number,
  griefersOnly = false,
): string {
  const dirToken = direction === 'prev' ? 'p' : 'n';
  const base = `mh:p:${invokerId}:${compactUuidForCustomId(playerId)}:${compactUuidForCustomId(leagueId)}:${dirToken}:${currentPage}`;
  return griefersOnly ? `${base}:g` : base;
}

export function parseMatchHistoryPageCustomId(customId: string): {
  invokerId: string;
  playerId: string;
  leagueId: string;
  page: number;
  griefersOnly: boolean;
} | null {
  const parts = customId.split(':');
  // mh:p:invoker:player:league:dir:page → 7 parts
  // mh:p:invoker:player:league:dir:page:g → 8 parts (griefer filter)
  if ((parts.length !== 7 && parts.length !== 8) || parts[0] !== 'mh' || parts[1] !== 'p') {
    return null;
  }
  const griefersOnly = parts.length === 8;
  if (griefersOnly && parts[7] !== 'g') {
    return null;
  }
  const direction = parts[5];
  const currentPage = Number.parseInt(parts[6]!, 10);
  if (!Number.isFinite(currentPage) || currentPage < 1) {
    return null;
  }
  const invokerId = parts[2]!;
  const playerId = expandUuidFromCustomId(parts[3]!);
  const leagueId = expandUuidFromCustomId(parts[4]!);
  if (!invokerId || !playerId || !leagueId) {
    return null;
  }
  if (direction === 'prev' || direction === 'p') {
    return { invokerId, playerId, leagueId, page: currentPage - 1, griefersOnly };
  }
  if (direction === 'next' || direction === 'n') {
    return { invokerId, playerId, leagueId, page: currentPage + 1, griefersOnly };
  }
  return null;
}

export async function resolveHistoryPlayer(
  gameId: string,
  lookup: RankLookup,
): Promise<{ id: string; username: string }> {
  if (lookup.kind === 'both') {
    throw new MatchServiceError('Provide either a Discord user or a nick, not both.');
  }

  const player = await findPlayerForRankLookup(gameId, lookup);
  if (!player) {
    if (lookup.kind === 'self') {
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
  griefersOnly?: boolean;
}): Promise<MatchHistoryPage> {
  const griefersOnly = input.griefersOnly === true;
  const where: Prisma.MatchWhereInput = griefersOnly
    ? {
        leagueId: input.leagueId,
        status: { in: ['COMPLETED', 'CANCELLED'] satisfies MatchStatus[] },
        players: { some: { playerId: input.playerId, isGriefer: true } },
      }
    : {
        leagueId: input.leagueId,
        status: 'COMPLETED',
        players: { some: { playerId: input.playerId } },
      };

  const totalMatches = await prisma.match.count({ where });
  const totalPages = Math.max(1, Math.ceil(totalMatches / MATCH_HISTORY_PAGE_SIZE));
  const page = clampMatchHistoryPage(input.page, totalPages);
  const skip = (page - 1) * MATCH_HISTORY_PAGE_SIZE;

  const [matches, leagueRow] = await Promise.all([
    prisma.match.findMany({
      where,
      orderBy: griefersOnly
        ? [{ updatedAt: 'desc' }, { createdAt: 'desc' }]
        : [{ completedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      skip,
      take: MATCH_HISTORY_PAGE_SIZE,
      include: {
        players: {
          include: { player: true, stats: true },
          orderBy: { slot: 'asc' },
        },
      },
    }),
    prisma.league.findUnique({
      where: { id: input.leagueId },
      select: { gameId: true },
    }),
  ]);

  const catalog = await loadHeroCatalog();
  const heroNameById = new Map(catalog.map((h) => [h.id, h.name]));
  const leagueGameId = leagueRow?.gameId ?? null;

  const [resetAtByPlayer, completedMatchRows] = await Promise.all([
    loadLatestRankResetAtByPlayer(input.leagueId, [input.playerId]),
    prisma.matchPlayer.findMany({
      where: {
        playerId: input.playerId,
        result: { in: ['WIN', 'LOSS'] },
        match: { leagueId: input.leagueId, status: 'COMPLETED' },
      },
      select: {
        playerId: true,
        result: true,
        match: { select: { completedAt: true, createdAt: true } },
      },
    }),
  ]);

  const resetAt = resetAtByPlayer.get(input.playerId);
  const gamesCountRows = completedMatchRows.map((row) => ({
    playerId: row.playerId,
    result: row.result,
    completedAt: row.match.completedAt ?? row.match.createdAt,
  }));

  const statsObjectIds = matches.flatMap((match) => {
    const mp = match.players.find((player) => player.playerId === input.playerId);
    const objectId = mp?.stats?.heroObjectId;
    return objectId != null ? [objectId] : [];
  });
  const gameHeroNames =
    leagueGameId != null
      ? await resolveHeroDisplayNames(leagueGameId, statsObjectIds)
      : new Map<number, string>();

  const rows: MatchHistoryRow[] = [];
  for (const match of matches) {
    const mp = match.players.find((player) => player.playerId === input.playerId);
    if (!mp) {
      continue;
    }
    if (mp.team !== 1 && mp.team !== 2) {
      continue;
    }

    const heroName = resolveMatchHistoryHeroName(mp, heroNameById, gameHeroNames, leagueGameId);

    const endedAt = matchEndedAt(match);

    if (match.status === 'CANCELLED') {
      if (!mp.isGriefer) {
        continue;
      }

      const leagueGames = countCompletedGamesThrough(
        gamesCountRows,
        input.playerId,
        endedAt,
        resetAt,
      );
      rows.push({
        matchId: match.id,
        completedAt: endedAt,
        result: 'CANCELLED',
        team: mp.team,
        heroName,
        isQuitter: mp.isQuitter,
        isGriefer: mp.isGriefer,
        grieferKiAccrued: mp.grieferKiAccrued,
        leagueGames,
      });
      continue;
    }

    if (mp.result !== 'WIN' && mp.result !== 'LOSS') {
      continue;
    }

    const globalDelta = await loadPlayerGlobalDeltaForMatch(
      match as MatchWithPlayers,
      input.playerId,
    );
    const leagueGames = countCompletedGamesThrough(
      gamesCountRows,
      input.playerId,
      endedAt,
      resetAt,
    );
    rows.push({
      matchId: match.id,
      completedAt: endedAt,
      result: mp.result,
      team: mp.team,
      heroName,
      isQuitter: mp.isQuitter,
      isGriefer: mp.isGriefer,
      grieferKiAccrued: mp.grieferKiAccrued,
      globalDelta,
      leagueGames,
    });
  }

  return {
    targetPlayerId: input.playerId,
    targetUsername: input.username,
    page,
    totalPages,
    totalMatches,
    griefersOnly,
    rows,
  };
}

export function buildMatchHistoryEmbed(
  page: MatchHistoryPage,
  _leagueId: string,
  teamLabelFor: (team: 1 | 2) => string,
  options?: { showTeam?: boolean },
): EmbedBuilder {
  const showTeam = options?.showTeam !== false;
  const embed = new EmbedBuilder()
    .setColor(0xf0b232)
    .setAuthor({ name: page.targetUsername })
    .setTitle(page.griefersOnly ? 'Match history · griefers' : 'Match history')
    .setDescription(
      page.griefersOnly
        ? `Griefer matches only · Page **${page.page}** of **${page.totalPages}** · ${page.totalMatches} matches`
        : `Page **${page.page}** of **${page.totalPages}** · ${page.totalMatches} matches`,
    );

  if (page.rows.length === 0) {
    embed.addFields({
      name: 'Matches',
      value: page.griefersOnly
        ? '_No griefer matches for this player._'
        : '_No completed matches yet._',
    });
  } else {
    embed.addFields(
      ...page.rows.map((row) =>
        formatMatchHistoryField(row, showTeam ? teamLabelFor(row.team) : ''),
      ),
    );
  }

  if (page.totalPages > 1) {
    embed.setFooter({
      text: 'Tap an id → /match show · Only you can use the buttons',
    });
  } else if (page.totalMatches > 0) {
    embed.setFooter({
      text: page.griefersOnly
        ? 'Copy an id → /match show (completed) or /match ungrief|/match unquit (cancelled)'
        : 'Copy an id → /match show match_id:…',
    });
  }

  return embed;
}

export function buildMatchHistoryPageButtons(input: {
  invokerId: string;
  playerId: string;
  leagueId: string;
  page: number;
  totalPages: number;
  griefersOnly?: boolean;
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
          input.griefersOnly === true,
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
          input.griefersOnly === true,
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

  const leagueId = requireLeagueId(match);

  const leagues = await listLeaguesForGuild(input.guildId);
  const allowed = new Set(leagues.map((league) => league.id));
  if (!allowed.has(leagueId)) {
    throw new MatchServiceError('This match was not found.');
  }

  if (input.leagueId && leagueId !== input.leagueId) {
    throw new MatchServiceError('This match was not found.');
  }

  if (match.status !== 'COMPLETED') {
    throw new MatchServiceError('This match is not completed.');
  }

  const profile = await getGameProfileForMatch(match);
  const winningTeam = winningTeamFromPlayers(match.players);
  const ratingPreview = await resolveCompletedRatingPreview(match);
  const embed = buildMatchCompletedEmbed(match.id, matchToLobbyPlayers(match), {
    winningTeam,
    profile,
    timestamp: match.completedAt ?? match.createdAt,
    ...(ratingPreview ? { ratingPreview } : {}),
  });

  const stats = await loadMatchPlayerStatsLines(match.id);
  if (stats.length > 0) {
    embed.addFields({
      name: 'Match stats',
      value: formatMatchStatsFieldValue(stats),
      inline: false,
    });
  }

  return { match, embed };
}
