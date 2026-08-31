import { SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import {
  getGameProfileForLeague,
  getLeagueOption,
  resolveLeagueIdFromInteraction,
  respondLeagueAutocomplete,
  withOptionalLeagueOption,
} from '../../services/league/index.js';
import { buildHeroPlayersEmbed } from '../../services/player/hero-players-embed.js';
import {
  loadHeroPlayerRankings,
  parseStatsWindows,
  type HeroPlayerSort,
} from '../../services/player/hero-stats.js';
import { listWosHeroNamesForLeague } from '../../services/player/wos-hero-names.js';

const log = createLogger('hero_players_cmd');

const WOS_STATS_ONLY_MESSAGE = 'Hero/item stats are only available for WOS leagues.';

const SORT_CHOICES: Array<{ name: string; value: HeroPlayerSort }> = [
  { name: 'Win rate', value: 'win_rate' },
  { name: 'Games played', value: 'games' },
  { name: 'Avg damage', value: 'damage' },
  { name: 'KDA', value: 'kda' },
];

function parseHeroPlayerSort(raw: string | null): HeroPlayerSort {
  const match = SORT_CHOICES.find((choice) => choice.value === raw);
  return match?.value ?? 'win_rate';
}

function parseHeroPlayersLimit(raw: string | null): number {
  if (raw === '5') {
    return 5;
  }
  if (raw === '25') {
    return 25;
  }
  return 10;
}

export const data = withOptionalLeagueOption(
  new SlashCommandBuilder()
    .setName('hero_players')
    .setDescription('WOS hero top players — sortable rankings')
    .addStringOption((option) =>
      option.setName('hero').setDescription('Hero name').setRequired(true).setAutocomplete(true),
    )
    .addStringOption((option) =>
      option
        .setName('sort')
        .setDescription('Sort players by')
        .setRequired(false)
        .addChoices(...SORT_CHOICES),
    )
    .addStringOption((option) =>
      option
        .setName('limit')
        .setDescription('Number of players to show')
        .setRequired(false)
        .addChoices(
          { name: '5', value: '5' },
          { name: '10', value: '10' },
          { name: '25', value: '25' },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('window')
        .setDescription('Stats window')
        .setRequired(false)
        .addChoices(
          { name: 'Both', value: 'both' },
          { name: 'Last 10', value: 'last10' },
          { name: 'Overall', value: 'overall' },
        ),
    ),
);

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (await respondLeagueAutocomplete(interaction)) {
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'hero') {
    await interaction.respond([]);
    return;
  }

  const resolved = await resolveLeagueIdFromInteraction(
    interaction,
    interaction.options.getString('league'),
  );
  if (!resolved.ok) {
    await interaction.respond([]);
    return;
  }

  let gameId: string;
  try {
    const profile = await getGameProfileForLeague(resolved.leagueId);
    if (profile.postMatchStats !== 'wos2_bot_v1') {
      await interaction.respond([]);
      return;
    }
    gameId = profile.gameId;
  } catch {
    await interaction.respond([]);
    return;
  }

  const heroes = await listWosHeroNamesForLeague(resolved.leagueId, gameId);
  const query = focused.value.toLowerCase();
  const choices = heroes
    .filter((hero) => hero.toLowerCase().includes(query))
    .slice(0, 25)
    .map((hero) => ({ name: hero.slice(0, 100), value: hero.slice(0, 100) }));

  await interaction.respond(choices);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const heroName = interaction.options.getString('hero', true);
  const sort = parseHeroPlayerSort(interaction.options.getString('sort'));
  const limit = parseHeroPlayersLimit(interaction.options.getString('limit'));
  const windowRaw = interaction.options.getString('window');
  const windows = parseStatsWindows(windowRaw === 'both' ? null : windowRaw);

  await interaction.deferReply();

  try {
    const resolved = await resolveLeagueIdFromInteraction(
      interaction,
      getLeagueOption(interaction),
    );
    if (!resolved.ok) {
      await interaction.editReply({ content: resolved.message });
      return;
    }

    const profile = await getGameProfileForLeague(resolved.leagueId);
    if (profile.postMatchStats !== 'wos2_bot_v1') {
      await interaction.editReply({ content: WOS_STATS_ONLY_MESSAGE });
      return;
    }

    const rankings = await loadHeroPlayerRankings({
      leagueId: resolved.leagueId,
      gameId: profile.gameId,
      heroName,
      sort,
      limit,
      windows,
    });

    if (!rankings) {
      await interaction.editReply({
        content: `No completed matches found for **${heroName}** in this league.`,
      });
      return;
    }

    const league = await prisma.league.findUnique({
      where: { id: resolved.leagueId },
      select: { name: true },
    });

    await interaction.editReply({
      embeds: [buildHeroPlayersEmbed(rankings, { leagueName: league?.name })],
    });
  } catch (error) {
    log.error({ err: error }, 'hero_players command failed');
    await interaction.editReply({ content: 'Something went wrong loading hero player rankings.' });
  }
}
