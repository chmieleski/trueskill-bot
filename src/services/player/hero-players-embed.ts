import { EmbedBuilder } from 'discord.js';
import { formatCompactStatNumber } from '../match/match-stats-upload.js';
import type {
  HeroPlayerSort,
  HeroPlayersResult,
  HeroRankedPlayer,
  StatsWindow,
} from './hero-stats.js';

const HERO_STATS_GOLD = 0xe8a317;

const SORT_LABELS: Record<HeroPlayerSort, string> = {
  win_rate: 'Win rate',
  games: 'Games played',
  damage: 'Avg damage',
  kda: 'KDA',
};

function formatPlayersWindowLabel(window: StatsWindow): string {
  return window === 'last20' ? 'Last 20 games' : 'Overall';
}

function formatRankedPlayer(rank: number, player: HeroRankedPlayer): string {
  return (
    `${rank}. ${player.username} · ${player.games}G · ${player.wins}W ${player.losses}L · ` +
    `${player.winRatePercent}% · avg ${formatCompactStatNumber(player.avgDamage)} dmg · ` +
    `KDA ${player.kda}`
  );
}

function formatRankedPlayers(players: HeroRankedPlayer[]): string {
  if (players.length === 0) {
    return '_Not enough data (need 3+ games per player)._';
  }

  return players.map((player, index) => formatRankedPlayer(index + 1, player)).join('\n');
}

/** Build the Discord embed for `/hero_players` results. */
export function buildHeroPlayersEmbed(
  result: HeroPlayersResult,
  options?: { leagueName?: string },
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(HERO_STATS_GOLD)
    .setTitle(`${result.heroDisplayName} — Top players by ${SORT_LABELS[result.sort]}`);

  if (options?.leagueName) {
    embed.setDescription(options.leagueName);
  }

  const windowOrder: StatsWindow[] = ['last20', 'overall'];
  for (const window of windowOrder) {
    const players = result.windows[window];
    if (!players) {
      continue;
    }

    embed.addFields({
      name: formatPlayersWindowLabel(window),
      value: formatRankedPlayers(players),
      inline: false,
    });
  }

  return embed;
}
