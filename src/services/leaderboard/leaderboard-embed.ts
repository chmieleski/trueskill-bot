import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import type {
  HeroBoardSlice,
  HeroLeaderboardEntry,
  OverallLeaderboardEntry,
  OverallLeaderboardPage,
} from './leaderboard.js';
import { chunkLeaderboardEntries } from './leaderboard.js';

const RANK_GOLD = 0xf0b232;

export function formatRankPrefix(rank: number): string {
  if (rank === 1) {
    return '🥇';
  }
  if (rank === 2) {
    return '🥈';
  }
  if (rank === 3) {
    return '🥉';
  }
  return `#${rank}`;
}

export function formatOverallTable(entries: OverallLeaderboardEntry[]): string {
  if (entries.length === 0) {
    return '_No ranked players yet._';
  }

  const nameWidth = Math.max(...entries.map((entry) => entry.username.length), 'Player'.length);
  const kiWidth = Math.max(...entries.map((entry) => String(entry.ki).length), 'Ki'.length);
  const header = `${'#'.padEnd(3)} ${'Player'.padEnd(nameWidth)}  ${'Ki'.padStart(kiWidth)}  G`;
  const lines = entries.map((entry) => {
    const prefix = formatRankPrefix(entry.rank).padEnd(3);
    const name = entry.username.padEnd(nameWidth, ' ');
    const ki = String(entry.ki).padStart(kiWidth, ' ');
    return `${prefix} ${name}  ${ki}  ${entry.games}`;
  });
  return `\`\`\`\n${header}\n${lines.join('\n')}\n\`\`\``;
}

function formatHeroCompactTable(entries: HeroLeaderboardEntry[]): string {
  if (entries.length === 0) {
    return '_No games yet_';
  }

  const nameWidth = Math.max(...entries.map((entry) => entry.username.length));
  const kiWidth = Math.max(...entries.map((entry) => String(entry.ki).length));
  const lines = entries.map((entry) => {
    const prefix = formatRankPrefix(entry.rank).padEnd(3);
    const name = entry.username.padEnd(nameWidth, ' ');
    const ki = String(entry.ki).padStart(kiWidth, ' ');
    return `${prefix} ${name}  ${ki}`;
  });
  return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

export function buildOverallLeaderboardEmbed(
  page: OverallLeaderboardPage,
  options?: { live?: boolean; updatedAt?: Date },
): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(RANK_GOLD).setTitle('Global Leaderboard');

  if (options?.live) {
    // Discord parses <t:…> only in description/fields — footers are plain text.
    let description = formatOverallTable(page.entries);
    if (options.updatedAt) {
      const unix = Math.floor(options.updatedAt.getTime() / 1000);
      description += `\n\nUpdated <t:${unix}:R>`;
    }
    embed.setDescription(description);
  } else {
    embed.setDescription(
      `Page ${page.page} of ${page.totalPages} · ${page.totalPlayers} players\n\n${formatOverallTable(page.entries)}`,
    );
    if (page.totalPages > 1) {
      embed.setFooter({
        text: 'Use /leaderboard show page:N to jump · Only you can use the buttons',
      });
    } else if (page.totalPlayers > 0) {
      embed.setFooter({ text: 'Only you can use the buttons' });
    }
  }

  return embed;
}

export function buildOverallLiveLeaderboardEmbeds(
  entries: OverallLeaderboardEntry[],
  updatedAt: Date,
): EmbedBuilder[] {
  const unix = Math.floor(updatedAt.getTime() / 1000);
  const stamp = `\n\nUpdated <t:${unix}:R>`;
  const chunks =
    entries.length === 0 ? [[]] : chunkLeaderboardEntries(entries);

  return chunks.map((chunk, index) => {
    const isLast = index === chunks.length - 1;
    const title =
      index === 0 ? 'Global Leaderboard' : 'Global Leaderboard (continued)';
    let description = formatOverallTable(chunk);
    if (isLast) {
      description += stamp;
    }
    return new EmbedBuilder().setColor(RANK_GOLD).setTitle(title).setDescription(description);
  });
}

export function buildHeroLeaderboardEmbed(
  heroName: string,
  entries: HeroLeaderboardEntry[],
): EmbedBuilder {
  const description =
    entries.length === 0
      ? `_No games yet for ${heroName}._`
      : formatOverallTable(
          entries.map((entry) => ({
            rank: entry.rank,
            playerId: entry.playerId,
            username: entry.username,
            ki: entry.ki,
            games: entry.matchesPlayed,
            discordId: null,
          })),
        );

  return new EmbedBuilder()
    .setColor(RANK_GOLD)
    .setTitle(`${heroName} Leaderboard`)
    .setDescription(description);
}

export function buildAllHeroLeaderboardsEmbed(slices: HeroBoardSlice[]): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(RANK_GOLD).setTitle('Hero Leaderboards');

  for (const slice of slices) {
    embed.addFields({
      name: slice.heroName,
      value: formatHeroCompactTable(slice.entries),
      inline: true,
    });
  }

  return embed;
}

export function buildLeaderboardPageCustomId(
  invokerId: string,
  direction: 'prev' | 'next',
  currentPage: number,
  leagueId: string,
): string {
  return `leaderboard:page:${invokerId}:${direction}:${currentPage}:${leagueId}`;
}

export function parseLeaderboardPageCustomId(
  customId: string,
): { invokerId: string; page: number; leagueId: string } | null {
  const parts = customId.split(':');
  if (parts.length !== 6 || parts[0] !== 'leaderboard' || parts[1] !== 'page') {
    return null;
  }

  const direction = parts[3];
  const currentPage = Number.parseInt(parts[4]!, 10);
  const leagueId = parts[5]!;
  if (!Number.isFinite(currentPage) || currentPage < 1 || !leagueId) {
    return null;
  }

  if (direction === 'prev') {
    return { invokerId: parts[2]!, page: currentPage - 1, leagueId };
  }
  if (direction === 'next') {
    return { invokerId: parts[2]!, page: currentPage + 1, leagueId };
  }

  return null;
}

export function buildLeaderboardPageButtons(input: {
  invokerId: string;
  leagueId: string;
  page: number;
  totalPages: number;
}): ActionRowBuilder<ButtonBuilder>[] {
  if (input.totalPages < 1) {
    return [];
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildLeaderboardPageCustomId(input.invokerId, 'prev', input.page, input.leagueId))
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page <= 1),
    new ButtonBuilder()
      .setCustomId(buildLeaderboardPageCustomId(input.invokerId, 'next', input.page, input.leagueId))
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page >= input.totalPages),
  );

  return [row];
}
