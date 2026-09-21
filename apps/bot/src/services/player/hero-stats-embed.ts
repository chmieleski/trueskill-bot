import { MatchResult } from '@dbz/db';
import { EmbedBuilder } from 'discord.js';
import { formatCompactStatNumber } from '../match/match-stats-upload.js';
import type {
  HeroRecentGame,
  HeroStatsResult,
  HeroWindowStats,
  StatsWindow,
} from './hero-stats.js';

const HERO_STATS_GOLD = 0xe8a317;

function formatWindowLabel(window: StatsWindow, games: number): string {
  if (window === 'last20') {
    return games < 20 ? `Last ${games} games` : 'Last 20 games';
  }
  return 'Overall';
}

function formatStatLine(stats: HeroWindowStats): string {
  return (
    `${stats.games}G · Avg ${formatCompactStatNumber(stats.avgDamage)} dmg · ` +
    `${formatCompactStatNumber(stats.avgTaken)} taken · ` +
    `${formatCompactStatNumber(stats.avgHeal)} heal · KDA ${stats.kda}`
  );
}

function formatTopPlayers(stats: HeroWindowStats): string {
  if (stats.topPlayers.length === 0) {
    return '_Not enough data (need 3+ games per player)._';
  }

  return stats.topPlayers
    .map((player) => {
      const wr = `${player.winRatePercent}%`;
      return `${player.username} · ${player.games}G · ${player.wins}W ${player.losses}L · ${wr}`;
    })
    .join('\n');
}

function formatRecentGameLine(game: HeroRecentGame, playerView: boolean): string {
  const outcome = game.result === MatchResult.WIN ? 'Win' : 'Loss';
  const unix = game.completedAt ? Math.floor(game.completedAt.getTime() / 1000) : null;
  const dateBit = unix !== null ? `<t:${unix}:D>` : 'Unknown date';

  if (playerView) {
    const emoji = game.result === MatchResult.WIN ? '✅' : '❌';
    return `${emoji} ${outcome} · ${dateBit}\n\`${game.matchId}\``;
  }

  return `${game.username} · ${outcome} · ${dateBit}\n\`${game.matchId}\``;
}

function formatRecentGames(games: HeroRecentGame[], playerView: boolean): string {
  return games.map((game) => formatRecentGameLine(game, playerView)).join('\n\n');
}

/** Build the Discord embed for `/hero` results. */
export function buildHeroStatsEmbed(
  result: HeroStatsResult,
  options?: { leagueName?: string },
): EmbedBuilder {
  const title = result.playerUsername
    ? `${result.playerUsername} on ${result.heroDisplayName}`
    : `${result.heroDisplayName} — League stats`;

  const embed = new EmbedBuilder().setColor(HERO_STATS_GOLD).setTitle(title);

  if (options?.leagueName) {
    embed.setDescription(options.leagueName);
  }

  const windowOrder: StatsWindow[] = ['last20', 'overall'];
  for (const window of windowOrder) {
    const stats = result.windows[window];
    if (!stats) {
      continue;
    }

    let value = formatStatLine(stats);
    if (!result.playerUsername) {
      value += `\n**Top players**\n${formatTopPlayers(stats)}`;
    }

    embed.addFields({
      name: formatWindowLabel(window, stats.games),
      value,
      inline: false,
    });
  }

  if (result.recentGames.length > 0) {
    embed.addFields({
      name: 'Recent games',
      value: formatRecentGames(result.recentGames, Boolean(result.playerUsername)),
      inline: false,
    });
  }

  if (result.rankResetAt) {
    embed.setFooter({ text: `Since rank reset ${result.rankResetAt.toISOString().slice(0, 10)}` });
  }

  return embed;
}
