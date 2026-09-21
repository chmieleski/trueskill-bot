import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { chunkLeaderboardEntries } from './leaderboard.js';
import { formatRankPrefix } from './leaderboard-embed.js';
import type {
  GrieferLeaderboardDisplayMode,
  GrieferLeaderboardEntry,
  GrieferLeaderboardPage,
  GrieferLeaderboardSortMode,
} from './griefer-leaderboard.js';

const RANK_GOLD = 0xf0b232;

const EMPTY_GRIEFERS_COPY = '_No griefers recorded yet._';
const EMPTY_RATE_SORT_COPY = '_No completed matches yet._';

/** Format grief rate as a one-decimal percentage string. */
export function formatGriefRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function grieferEmptyCopy(sort: GrieferLeaderboardSortMode): string {
  return sort === 'rate' ? EMPTY_RATE_SORT_COPY : EMPTY_GRIEFERS_COPY;
}

function sortFooterLabel(sort: GrieferLeaderboardSortMode): string {
  return sort === 'rate' ? 'Sorted by rate' : 'Sorted by griefs';
}

/** Monospace table for griefer rows; omits columns per display mode. */
export function formatGrieferTable(
  entries: GrieferLeaderboardEntry[],
  display: GrieferLeaderboardDisplayMode,
): string {
  if (entries.length === 0) {
    return EMPTY_GRIEFERS_COPY;
  }

  const showGriefs = display === 'count' || display === 'both';
  const showRate = display === 'rate' || display === 'both';
  const showTax = display === 'both';

  const nameWidth = Math.max(...entries.map((entry) => entry.username.length), 'Player'.length);
  const griefWidth = showGriefs
    ? Math.max(...entries.map((entry) => String(entry.griefCount).length), 'Griefs'.length)
    : 0;
  const rateWidth = showRate
    ? Math.max(...entries.map((entry) => formatGriefRate(entry.rate).length), 'Rate'.length)
    : 0;
  const taxWidth = showTax
    ? Math.max(...entries.map((entry) => String(entry.pendingTaxKi).length), 'Tax'.length)
    : 0;
  const gamesWidth = Math.max(
    ...entries.map((entry) => String(entry.completedCount).length),
    'G'.length,
  );

  const headerParts = [`${'#'.padEnd(3)}`, 'Player'.padEnd(nameWidth)];
  if (showGriefs) {
    headerParts.push('Griefs'.padStart(griefWidth));
  }
  if (showRate) {
    headerParts.push('Rate'.padStart(rateWidth));
  }
  if (showTax) {
    headerParts.push('Tax'.padStart(taxWidth));
  }
  headerParts.push('G'.padStart(gamesWidth));
  const header = headerParts.join('  ');

  const lines = entries.map((entry) => {
    const prefix = formatRankPrefix(entry.rank).padEnd(3);
    const parts = [`${prefix}`, entry.username.padEnd(nameWidth, ' ')];
    if (showGriefs) {
      parts.push(String(entry.griefCount).padStart(griefWidth, ' '));
    }
    if (showRate) {
      parts.push(formatGriefRate(entry.rate).padStart(rateWidth, ' '));
    }
    if (showTax) {
      parts.push(String(entry.pendingTaxKi).padStart(taxWidth, ' '));
    }
    parts.push(String(entry.completedCount).padStart(gamesWidth, ' '));
    return parts.join('  ');
  });

  return `\`\`\`\n${header}\n${lines.join('\n')}\n\`\`\``;
}

/** Slash-command paginated griefer leaderboard embed. */
export function buildGrieferLeaderboardEmbed(page: GrieferLeaderboardPage): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(RANK_GOLD).setTitle('Griefer Leaderboard');

  const tableBody =
    page.entries.length === 0
      ? grieferEmptyCopy(page.sort)
      : formatGrieferTable(page.entries, page.display);

  embed.setDescription(
    `Page ${page.page} of ${page.totalPages} · ${page.totalPlayers} players\n\n${tableBody}`,
  );

  let footer = sortFooterLabel(page.sort);
  if (page.totalPages > 1) {
    footer += ' · Only you can use the buttons';
  }
  embed.setFooter({ text: footer });

  return embed;
}

/** Live channel griefer leaderboard embeds (chunked, timestamp on last). */
export function buildGrieferLiveLeaderboardEmbeds(
  entries: GrieferLeaderboardEntry[],
  display: GrieferLeaderboardDisplayMode,
  sort: GrieferLeaderboardSortMode,
  updatedAt: Date,
): EmbedBuilder[] {
  const unix = Math.floor(updatedAt.getTime() / 1000);
  const stamp = `\n\nUpdated <t:${unix}:R>`;
  const chunks = entries.length === 0 ? [[]] : chunkLeaderboardEntries(entries);

  const sortFooter = sortFooterLabel(sort);

  return chunks.map((chunk, index) => {
    const isLast = index === chunks.length - 1;
    const title = index === 0 ? 'Griefer Leaderboard' : 'Griefer Leaderboard (continued)';
    let description =
      chunk.length === 0 ? grieferEmptyCopy(sort) : formatGrieferTable(chunk, display);
    if (isLast) {
      description += stamp;
    }
    return new EmbedBuilder()
      .setColor(RANK_GOLD)
      .setTitle(title)
      .setDescription(description)
      .setFooter({ text: sortFooter });
  });
}

export function buildGrieferPageCustomId(
  invokerId: string,
  direction: 'prev' | 'next',
  currentPage: number,
): string {
  return `lb:griefers:page:${invokerId}:${direction}:${currentPage}`;
}

export function parseGrieferPageCustomId(
  customId: string,
): { invokerId: string; page: number } | null {
  const parts = customId.split(':');
  if (parts.length !== 6 || parts[0] !== 'lb' || parts[1] !== 'griefers' || parts[2] !== 'page') {
    return null;
  }

  const direction = parts[4];
  const currentPage = Number.parseInt(parts[5]!, 10);
  if (!Number.isFinite(currentPage) || currentPage < 1) {
    return null;
  }

  if (direction === 'prev') {
    return { invokerId: parts[3]!, page: currentPage - 1 };
  }
  if (direction === 'next') {
    return { invokerId: parts[3]!, page: currentPage + 1 };
  }

  return null;
}

export function buildGrieferPageButtons(input: {
  invokerId: string;
  page: number;
  totalPages: number;
}): ActionRowBuilder<ButtonBuilder>[] {
  if (input.totalPages < 1) {
    return [];
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildGrieferPageCustomId(input.invokerId, 'prev', input.page))
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page <= 1),
    new ButtonBuilder()
      .setCustomId(buildGrieferPageCustomId(input.invokerId, 'next', input.page))
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page >= input.totalPages),
  );

  return [row];
}
