import { EmbedBuilder } from 'discord.js';
import { formatMonospaceTable, truncateDiscordFieldValue } from '../../lib/discord-embed-table.js';
import type { ItemSort, ItemStatsResult, ItemWindowEntry, StatsWindow } from './item-stats.js';

const ITEM_STATS_BLUE = 0x5865f2;

const SORT_LABELS: Record<ItemSort, string> = {
  buy_rate: 'Buy rate',
  win_rate: 'Win rate',
  picks: 'Picks',
};

function formatWinRatePercent(winRatePercent: number | null): string {
  return winRatePercent === null ? '—' : `${winRatePercent}%`;
}

function formatItemStatsTable(entries: ItemWindowEntry[]): string {
  return formatMonospaceTable(entries, [
    {
      header: 'Item',
      align: 'left',
      maxWidth: 26,
      cell: (entry) => entry.displayName,
    },
    {
      header: 'Buy',
      align: 'right',
      maxWidth: 5,
      cell: (entry) => `${entry.buyRatePercent}%`,
    },
    {
      header: 'WR',
      align: 'right',
      maxWidth: 6,
      cell: (entry) => formatWinRatePercent(entry.winRatePercent),
    },
    {
      header: 'Picks',
      align: 'right',
      maxWidth: 5,
      cell: (entry) => String(entry.gamesWithItem),
    },
  ]);
}

function formatItemsList(entries: ItemWindowEntry[]): string {
  if (entries.length === 0) {
    return '_No item data yet — stats appear after matches with uploaded reports._';
  }
  return truncateDiscordFieldValue(formatItemStatsTable(entries));
}

/** Build the Discord embed for `/items` results. */
export function buildItemStatsEmbed(
  result: ItemStatsResult,
  options?: { leagueName?: string },
): EmbedBuilder {
  const titleBase = result.heroDisplayName
    ? `Item stats on ${result.heroDisplayName}`
    : 'Item stats — league-wide';

  const embed = new EmbedBuilder()
    .setColor(ITEM_STATS_BLUE)
    .setTitle(`${titleBase} — sorted by ${SORT_LABELS[result.sort]}`);

  if (options?.leagueName) {
    embed.setDescription(options.leagueName);
  }

  const windowOrder: StatsWindow[] = ['last20', 'overall'];
  for (const window of windowOrder) {
    const entries = result.windows[window];
    if (!entries) {
      continue;
    }

    const label = window === 'last20' ? 'Last 20 games' : 'Overall';

    embed.addFields({
      name: label,
      value: formatItemsList(entries),
      inline: false,
    });
  }

  return embed;
}

export { formatItemStatsTable };
