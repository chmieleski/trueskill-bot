import { EmbedBuilder } from 'discord.js';
import type { ItemStatsResult, ItemWindowEntry, StatsWindow } from './item-stats.js';

const ITEM_STATS_BLUE = 0x5865f2;

function formatItemRow(entry: ItemWindowEntry): string {
  const wr = entry.winRatePercent === null ? '—' : `${entry.winRatePercent}%`;
  return `${entry.displayName} · ${entry.buyRatePercent}% buy · ${wr} WR · ${entry.gamesWithItem}G`;
}

function formatItemsList(entries: ItemWindowEntry[]): string {
  if (entries.length === 0) {
    return '_No item data yet — stats appear after matches with uploaded reports._';
  }
  return entries.map(formatItemRow).join('\n');
}

/** Build the Discord embed for `/items` results. */
export function buildItemStatsEmbed(
  result: ItemStatsResult,
  options?: { leagueName?: string },
): EmbedBuilder {
  const title = result.heroDisplayName
    ? `Item stats on ${result.heroDisplayName}`
    : 'Item stats — league-wide';

  const embed = new EmbedBuilder().setColor(ITEM_STATS_BLUE).setTitle(title);

  if (options?.leagueName) {
    embed.setDescription(options.leagueName);
  }

  const windowOrder: StatsWindow[] = ['last10', 'overall'];
  for (const window of windowOrder) {
    const entries = result.windows[window];
    if (!entries) {
      continue;
    }

    const label = window === 'last10' ? 'Last 10 games' : 'Overall';

    embed.addFields({
      name: label,
      value: formatItemsList(entries),
      inline: false,
    });
  }

  return embed;
}
