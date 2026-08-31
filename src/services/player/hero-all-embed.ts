import { EmbedBuilder } from 'discord.js';
import { formatMonospaceTable, truncateDiscordFieldValue } from '../../lib/discord-embed-table.js';
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
