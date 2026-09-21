import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { formatMonospaceTable, truncateDiscordFieldValue } from '../../lib/discord-embed-table.js';
import { compactUuidForCustomId, expandUuidFromCustomId } from '../match/compact-custom-id.js';
import { formatCompactStatNumber } from '../match/match-stats-upload.js';
import type {
  HeroAllEntry,
  HeroAllRankingsResult,
  HeroAllSort,
  HeroAllStatsWindow,
} from './hero-stats.js';

const HERO_ALL_BLUE = 0x5865f2;

const SORT_LABELS: Record<HeroAllSort, string> = {
  win_rate: 'Win rate',
  games: 'Games played',
  damage: 'Avg damage',
  taken: 'Avg damage taken',
  heal: 'Avg healing',
};

function formatWindowLabel(window: HeroAllStatsWindow): string {
  return window === 'last20' ? 'Last 20 games' : 'Overall';
}

function formatWinRatePercent(winRatePercent: number): string {
  return `${winRatePercent}%`;
}

function formatHeroAllTable(entries: HeroAllEntry[]): string {
  return formatMonospaceTable(entries, [
    {
      header: 'Hero',
      align: 'left',
      maxWidth: 14,
      cell: (entry) => entry.heroDisplayName,
    },
    {
      header: 'WR',
      align: 'right',
      maxWidth: 6,
      cell: (entry) => formatWinRatePercent(entry.winRatePercent),
    },
    {
      header: 'G',
      align: 'right',
      maxWidth: 4,
      cell: (entry) => String(entry.games),
    },
    {
      header: 'Dmg',
      align: 'right',
      maxWidth: 5,
      cell: (entry) => formatCompactStatNumber(entry.avgDamage),
    },
    {
      header: 'Taken',
      align: 'right',
      maxWidth: 5,
      cell: (entry) => formatCompactStatNumber(entry.avgTaken),
    },
    {
      header: 'Heal',
      align: 'right',
      maxWidth: 5,
      cell: (entry) => formatCompactStatNumber(entry.avgHeal),
    },
  ]);
}

function formatHeroAllList(entries: HeroAllEntry[]): string {
  if (entries.length === 0) {
    return '_No heroes on this page._';
  }
  return truncateDiscordFieldValue(formatHeroAllTable(entries));
}

/** Build the Discord embed for `/hero_all` results. */
export function buildHeroAllEmbed(
  result: HeroAllRankingsResult,
  options?: { leagueName?: string },
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(HERO_ALL_BLUE)
    .setTitle(`All heroes — sorted by ${SORT_LABELS[result.sort]}`);

  const pageLine = `Page **${result.page}** of **${result.totalPages}** · **${result.totalHeroes}** heroes`;
  embed.setDescription(options?.leagueName ? `${options.leagueName}\n${pageLine}` : pageLine);

  const windowOrder: HeroAllStatsWindow[] = ['last20', 'overall'];
  for (const window of windowOrder) {
    const entries = result.windows[window];
    if (!entries) {
      continue;
    }

    embed.addFields({
      name: formatWindowLabel(window),
      value: formatHeroAllList(entries),
      inline: false,
    });
  }

  return embed;
}

const HERO_ALL_SORT_TOKENS: Record<HeroAllSort, string> = {
  win_rate: 'wr',
  games: 'g',
  damage: 'd',
  taken: 't',
  heal: 'h',
};

const HERO_ALL_SORT_BY_TOKEN = Object.fromEntries(
  Object.entries(HERO_ALL_SORT_TOKENS).map(([sort, token]) => [token, sort]),
) as Record<string, HeroAllSort>;

/** Encode `/hero_all` window choice for Discord button custom ids. */
export function encodeHeroAllWindowsToken(windows: HeroAllStatsWindow[]): string {
  if (windows.length === 2) {
    return 'b';
  }
  if (windows[0] === 'last20') {
    return 'l';
  }
  return 'o';
}

/** Decode window token from a `/hero_all` pagination button custom id. */
export function decodeHeroAllWindowsToken(token: string): HeroAllStatsWindow[] | null {
  if (token === 'b') {
    return ['last20', 'overall'];
  }
  if (token === 'l') {
    return ['last20'];
  }
  if (token === 'o') {
    return ['overall'];
  }
  return null;
}

function encodeHeroAllSortToken(sort: HeroAllSort): string {
  return HERO_ALL_SORT_TOKENS[sort];
}

function decodeHeroAllSortToken(token: string): HeroAllSort | null {
  return HERO_ALL_SORT_BY_TOKEN[token] ?? null;
}

export function buildHeroAllPageCustomId(input: {
  invokerId: string;
  leagueId: string;
  direction: 'prev' | 'next';
  currentPage: number;
  sort: HeroAllSort;
  windows: HeroAllStatsWindow[];
}): string {
  const dirToken = input.direction === 'prev' ? 'p' : 'n';
  return [
    'ha',
    'p',
    input.invokerId,
    compactUuidForCustomId(input.leagueId),
    dirToken,
    String(input.currentPage),
    encodeHeroAllSortToken(input.sort),
    encodeHeroAllWindowsToken(input.windows),
  ].join(':');
}

export function parseHeroAllPageCustomId(customId: string): {
  invokerId: string;
  leagueId: string;
  page: number;
  sort: HeroAllSort;
  windows: HeroAllStatsWindow[];
} | null {
  const parts = customId.split(':');
  if (parts.length !== 8 || parts[0] !== 'ha' || parts[1] !== 'p') {
    return null;
  }

  const direction = parts[4];
  const currentPage = Number.parseInt(parts[5]!, 10);
  const sort = decodeHeroAllSortToken(parts[6]!);
  const windows = decodeHeroAllWindowsToken(parts[7]!);
  const leagueId = expandUuidFromCustomId(parts[3]!);
  const invokerId = parts[2]!;

  if (
    !invokerId ||
    !leagueId ||
    !Number.isFinite(currentPage) ||
    currentPage < 1 ||
    !sort ||
    !windows
  ) {
    return null;
  }

  if (direction === 'p' || direction === 'prev') {
    return { invokerId, leagueId, page: currentPage - 1, sort, windows };
  }
  if (direction === 'n' || direction === 'next') {
    return { invokerId, leagueId, page: currentPage + 1, sort, windows };
  }

  return null;
}

export function buildHeroAllPageButtons(input: {
  invokerId: string;
  leagueId: string;
  page: number;
  totalPages: number;
  sort: HeroAllSort;
  windows: HeroAllStatsWindow[];
}): ActionRowBuilder<ButtonBuilder>[] {
  if (input.totalPages <= 1) {
    return [];
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        buildHeroAllPageCustomId({
          invokerId: input.invokerId,
          leagueId: input.leagueId,
          direction: 'prev',
          currentPage: input.page,
          sort: input.sort,
          windows: input.windows,
        }),
      )
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page <= 1),
    new ButtonBuilder()
      .setCustomId(
        buildHeroAllPageCustomId({
          invokerId: input.invokerId,
          leagueId: input.leagueId,
          direction: 'next',
          currentPage: input.page,
          sort: input.sort,
          windows: input.windows,
        }),
      )
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page >= input.totalPages),
  );

  return [row];
}
