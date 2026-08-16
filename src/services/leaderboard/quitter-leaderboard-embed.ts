import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { chunkLeaderboardEntries } from './leaderboard.js';
import { formatRankPrefix } from './leaderboard-embed.js';
import type {
  QuitterLeaderboardDisplayMode,
  QuitterLeaderboardEntry,
  QuitterLeaderboardPage,
  QuitterLeaderboardSortMode,
} from './quitter-leaderboard.js';

const RANK_GOLD = 0xf0b232;

const EMPTY_QUITTERS_COPY = '_No quitters recorded yet._';
const EMPTY_RATE_SORT_COPY = '_No completed matches yet._';

/** Format quit rate as a one-decimal percentage string. */
export function formatQuitRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function quitterEmptyCopy(sort: QuitterLeaderboardSortMode): string {
  return sort === 'rate' ? EMPTY_RATE_SORT_COPY : EMPTY_QUITTERS_COPY;
}

function sortFooterLabel(sort: QuitterLeaderboardSortMode): string {
  return sort === 'rate' ? 'Sorted by rate' : 'Sorted by quits';
}

/** Monospace table for quitter rows; omits columns per display mode. */
export function formatQuitterTable(
  entries: QuitterLeaderboardEntry[],
  display: QuitterLeaderboardDisplayMode,
): string {
  if (entries.length === 0) {
    return EMPTY_QUITTERS_COPY;
  }

  const showQuits = display === 'count' || display === 'both';
  const showRate = display === 'rate' || display === 'both';

  const nameWidth = Math.max(...entries.map((entry) => entry.username.length), 'Player'.length);
  const quitsWidth = showQuits
    ? Math.max(...entries.map((entry) => String(entry.quitCount).length), 'Quits'.length)
    : 0;
  const rateWidth = showRate
    ? Math.max(...entries.map((entry) => formatQuitRate(entry.rate).length), 'Rate'.length)
    : 0;
  const gamesWidth = Math.max(
    ...entries.map((entry) => String(entry.completedCount).length),
    'G'.length,
  );

  const headerParts = [`${'#'.padEnd(3)}`, 'Player'.padEnd(nameWidth)];
  if (showQuits) {
    headerParts.push('Quits'.padStart(quitsWidth));
  }
  if (showRate) {
    headerParts.push('Rate'.padStart(rateWidth));
  }
  headerParts.push('G'.padStart(gamesWidth));
  const header = headerParts.join('  ');

  const lines = entries.map((entry) => {
    const prefix = formatRankPrefix(entry.rank).padEnd(3);
    const parts = [`${prefix}`, entry.username.padEnd(nameWidth, ' ')];
    if (showQuits) {
      parts.push(String(entry.quitCount).padStart(quitsWidth, ' '));
    }
    if (showRate) {
      parts.push(formatQuitRate(entry.rate).padStart(rateWidth, ' '));
    }
    parts.push(String(entry.completedCount).padStart(gamesWidth, ' '));
    return parts.join('  ');
  });

  return `\`\`\`\n${header}\n${lines.join('\n')}\n\`\`\``;
}

/** Slash-command paginated quitter leaderboard embed. */
export function buildQuitterLeaderboardEmbed(page: QuitterLeaderboardPage): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(RANK_GOLD).setTitle('Quitter Leaderboard');

  const tableBody =
    page.entries.length === 0
      ? quitterEmptyCopy(page.sort)
      : formatQuitterTable(page.entries, page.display);

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

/** Live channel quitter leaderboard embeds (chunked, timestamp on last). */
export function buildQuitterLiveLeaderboardEmbeds(
  entries: QuitterLeaderboardEntry[],
  display: QuitterLeaderboardDisplayMode,
  sort: QuitterLeaderboardSortMode,
  updatedAt: Date,
): EmbedBuilder[] {
  const unix = Math.floor(updatedAt.getTime() / 1000);
  const stamp = `\n\nUpdated <t:${unix}:R>`;
  const chunks = entries.length === 0 ? [[]] : chunkLeaderboardEntries(entries);

  return chunks.map((chunk, index) => {
    const isLast = index === chunks.length - 1;
    const title = index === 0 ? 'Quitter Leaderboard' : 'Quitter Leaderboard (continued)';
    let description =
      chunk.length === 0 ? quitterEmptyCopy(sort) : formatQuitterTable(chunk, display);
    if (isLast) {
      description += stamp;
    }
    return new EmbedBuilder().setColor(RANK_GOLD).setTitle(title).setDescription(description);
  });
}

export function buildQuitterPageCustomId(
  invokerId: string,
  direction: 'prev' | 'next',
  currentPage: number,
): string {
  return `lb:quitters:page:${invokerId}:${direction}:${currentPage}`;
}

export function parseQuitterPageCustomId(
  customId: string,
): { invokerId: string; page: number } | null {
  const parts = customId.split(':');
  if (parts.length !== 6 || parts[0] !== 'lb' || parts[1] !== 'quitters' || parts[2] !== 'page') {
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

export function buildQuitterPageButtons(input: {
  invokerId: string;
  page: number;
  totalPages: number;
}): ActionRowBuilder<ButtonBuilder>[] {
  if (input.totalPages < 1) {
    return [];
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildQuitterPageCustomId(input.invokerId, 'prev', input.page))
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page <= 1),
    new ButtonBuilder()
      .setCustomId(buildQuitterPageCustomId(input.invokerId, 'next', input.page))
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page >= input.totalPages),
  );

  return [row];
}
