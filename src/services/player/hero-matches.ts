import { createHash } from 'node:crypto';
import { MatchResult } from '@prisma/client';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { HeroSelection } from '../game/game-hero-catalog.js';
import { resolveHeroDisplayName, resolveHeroSelection } from '../game/game-hero-catalog.js';
import { compactUuidForCustomId, expandUuidFromCustomId } from '../match/compact-custom-id.js';
import { clampMatchHistoryPage } from '../match/match-history.js';
import {
  loadHeroGameRowsBySelection,
  normalizeHeroNameKey,
  type HeroStatsRow,
} from './hero-stats.js';
import { listWosHeroNamesForLeague } from './wos-hero-names.js';

export const HERO_MATCHES_PAGE_SIZE = 10;

function hashHeroNameKey(nameKey: string): string {
  return createHash('sha256').update(nameKey).digest('hex').slice(0, 8);
}

export type HeroMatchRow = {
  matchId: string;
  result: typeof MatchResult.WIN | typeof MatchResult.LOSS;
  completedAt: Date | null;
};

export type HeroMatchesPage = {
  heroDisplayName: string;
  targetPlayerId: string;
  targetUsername: string;
  page: number;
  totalPages: number;
  totalMatches: number;
  rankResetAt?: Date;
  rows: HeroMatchRow[];
};

/** Encode hero selection for Discord button custom ids (no colons, ≤9 chars). */
export function encodeHeroMatchesHeroToken(selection: HeroSelection): string {
  if (selection.objectId != null) {
    return String(selection.objectId);
  }
  return `h${hashHeroNameKey(selection.nameKey)}`;
}

/** Resolve a button token to a full hero selection with display name. */
export async function resolveHeroMatchesHeroToken(
  gameId: string,
  leagueId: string,
  token: string,
): Promise<HeroSelection | null> {
  if (token.startsWith('h')) {
    const hash = token.slice(1);
    if (!/^[0-9a-f]{8}$/i.test(hash)) {
      return null;
    }
    const heroes = await listWosHeroNamesForLeague(leagueId, gameId);
    for (const name of heroes) {
      const nameKey = normalizeHeroNameKey(name);
      if (hashHeroNameKey(nameKey) === hash.toLowerCase()) {
        return resolveHeroSelection(gameId, leagueId, name);
      }
    }
    return null;
  }

  const objectId = Number.parseInt(token, 10);
  if (!Number.isFinite(objectId)) {
    return null;
  }
  const displayName = await resolveHeroDisplayName(gameId, objectId);
  return {
    objectId,
    nameKey: normalizeHeroNameKey(displayName),
    displayName,
  };
}

function sortHeroMatchRows(rows: HeroStatsRow[]): HeroStatsRow[] {
  return [...rows].sort(
    (left, right) =>
      (right.completedAt?.getTime() ?? 0) - (left.completedAt?.getTime() ?? 0) ||
      right.matchId.localeCompare(left.matchId),
  );
}

function toHeroMatchRow(row: HeroStatsRow): HeroMatchRow {
  return {
    matchId: row.matchId,
    result: row.result,
    completedAt: row.completedAt,
  };
}

/** Paginated completed matches for one player on one hero. */
export async function loadHeroMatchesPage(input: {
  leagueId: string;
  gameId: string;
  selection: HeroSelection;
  playerId: string;
  username: string;
  page: number;
}): Promise<HeroMatchesPage> {
  const { rows, resetAt } = await loadHeroGameRowsBySelection({
    leagueId: input.leagueId,
    selection: input.selection,
    playerId: input.playerId,
  });

  const sorted = sortHeroMatchRows(rows);
  const totalMatches = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalMatches / HERO_MATCHES_PAGE_SIZE));
  const page = clampMatchHistoryPage(input.page, totalPages);
  const start = (page - 1) * HERO_MATCHES_PAGE_SIZE;

  return {
    heroDisplayName: input.selection.displayName,
    targetPlayerId: input.playerId,
    targetUsername: input.username,
    page,
    totalPages,
    totalMatches,
    rankResetAt: resetAt,
    rows: sorted.slice(start, start + HERO_MATCHES_PAGE_SIZE).map(toHeroMatchRow),
  };
}

export function formatHeroMatchField(row: HeroMatchRow): {
  name: string;
  value: string;
  inline: boolean;
} {
  const emoji = row.result === MatchResult.WIN ? '✅' : '❌';
  const outcome = row.result === MatchResult.WIN ? 'Win' : 'Loss';
  const unix = row.completedAt ? Math.floor(row.completedAt.getTime() / 1000) : null;
  const dateBit = unix !== null ? `<t:${unix}:D>` : 'Unknown date';

  return {
    name: `${emoji} ${outcome}`,
    value: `${dateBit}\n\`${row.matchId}\``,
    inline: false,
  };
}

export function buildHeroMatchesEmbed(
  page: HeroMatchesPage,
  options?: { leagueName?: string },
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xe8a317)
    .setTitle(`${page.targetUsername} on ${page.heroDisplayName}`)
    .setDescription(
      options?.leagueName
        ? `${options.leagueName}\nPage **${page.page}** of **${page.totalPages}** · ${page.totalMatches} matches`
        : `Page **${page.page}** of **${page.totalPages}** · ${page.totalMatches} matches`,
    );

  if (page.rows.length === 0) {
    embed.addFields({
      name: 'Matches',
      value: '_No completed matches on this hero yet._',
    });
  } else {
    embed.addFields(...page.rows.map((row) => formatHeroMatchField(row)));
  }

  if (page.totalPages > 1) {
    embed.setFooter({
      text: 'Copy an id → /match show match_id:… · Only you can use the buttons',
    });
  } else if (page.totalMatches > 0) {
    embed.setFooter({ text: 'Copy an id → /match show match_id:…' });
  }

  if (page.rankResetAt) {
    const resetNote = `Since rank reset ${page.rankResetAt.toISOString().slice(0, 10)}`;
    const footer = embed.data.footer?.text;
    embed.setFooter({ text: footer ? `${footer} · ${resetNote}` : resetNote });
  }

  return embed;
}

export function buildHeroMatchesPageCustomId(
  playerId: string,
  leagueId: string,
  heroToken: string,
  direction: 'prev' | 'next',
  currentPage: number,
): string {
  const dirToken = direction === 'prev' ? 'p' : 'n';
  return `hm:${compactUuidForCustomId(playerId)}:${compactUuidForCustomId(leagueId)}:${heroToken}:${dirToken}:${currentPage}`;
}

export function parseHeroMatchesPageCustomId(customId: string): {
  playerId: string;
  leagueId: string;
  heroToken: string;
  page: number;
} | null {
  const parts = customId.split(':');
  // hm:player:league:hero:dir:page → 6 parts
  if (parts.length !== 6 || parts[0] !== 'hm') {
    return null;
  }

  const direction = parts[4];
  const currentPage = Number.parseInt(parts[5]!, 10);
  if (!Number.isFinite(currentPage) || currentPage < 1) {
    return null;
  }

  const playerId = expandUuidFromCustomId(parts[1]!);
  const leagueId = expandUuidFromCustomId(parts[2]!);
  const heroToken = parts[3]!;
  if (!playerId || !leagueId || !heroToken) {
    return null;
  }

  if (direction === 'prev' || direction === 'p') {
    return { playerId, leagueId, heroToken, page: currentPage - 1 };
  }
  if (direction === 'next' || direction === 'n') {
    return { playerId, leagueId, heroToken, page: currentPage + 1 };
  }
  return null;
}

export function buildHeroMatchesPageButtons(input: {
  playerId: string;
  leagueId: string;
  heroToken: string;
  page: number;
  totalPages: number;
}): ActionRowBuilder<ButtonBuilder>[] {
  if (input.totalPages <= 1) {
    return [];
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        buildHeroMatchesPageCustomId(
          input.playerId,
          input.leagueId,
          input.heroToken,
          'prev',
          input.page,
        ),
      )
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page <= 1),
    new ButtonBuilder()
      .setCustomId(
        buildHeroMatchesPageCustomId(
          input.playerId,
          input.leagueId,
          input.heroToken,
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
