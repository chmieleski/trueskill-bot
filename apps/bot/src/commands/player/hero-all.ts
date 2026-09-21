import { SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import {
  getGameProfileForLeague,
  getLeagueOption,
  resolveLeagueIdFromInteraction,
  withOptionalLeagueOption,
} from '../../services/league/index.js';
import {
  buildHeroAllEmbed,
  buildHeroAllPageButtons,
} from '../../services/player/hero-all-embed.js';
import {
  loadAllHeroRankings,
  parseHeroAllStatsWindows,
  type HeroAllSort,
} from '../../services/player/hero-stats.js';

const log = createLogger('hero_all_cmd');

const WOS_STATS_ONLY_MESSAGE = 'Hero/item stats are only available for WOS leagues.';

const SORT_CHOICES: Array<{ name: string; value: HeroAllSort }> = [
  { name: 'Win rate', value: 'win_rate' },
  { name: 'Games played', value: 'games' },
  { name: 'Avg damage', value: 'damage' },
  { name: 'Avg damage taken', value: 'taken' },
  { name: 'Avg healing', value: 'heal' },
];

function parseHeroAllSort(raw: string | null): HeroAllSort {
  const match = SORT_CHOICES.find((choice) => choice.value === raw);
  return match?.value ?? 'win_rate';
}

export const data = withOptionalLeagueOption(
  new SlashCommandBuilder()
    .setName('hero_all')
    .setDescription('WOS league-wide hero rankings — sortable stats')
    .addStringOption((option) =>
      option
        .setName('sort')
        .setDescription('Sort heroes by')
        .setRequired(false)
        .addChoices(...SORT_CHOICES),
    )
    .addStringOption((option) =>
      option
        .setName('window')
        .setDescription('Stats window')
        .setRequired(false)
        .addChoices(
          { name: 'Both', value: 'both' },
          { name: 'Last 20', value: 'last20' },
          { name: 'Overall', value: 'overall' },
        ),
    )
    .addIntegerOption((option) =>
      option.setName('page').setDescription('Page number').setRequired(false).setMinValue(1),
    ),
);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sort = parseHeroAllSort(interaction.options.getString('sort'));
  const windowRaw = interaction.options.getString('window');
  const windows = parseHeroAllStatsWindows(windowRaw === 'both' ? null : windowRaw);
  const page = interaction.options.getInteger('page') ?? 1;

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

    const rankings = await loadAllHeroRankings({
      leagueId: resolved.leagueId,
      gameId: profile.gameId,
      sort,
      windows,
      page,
    });

    if (rankings.totalHeroes === 0) {
      await interaction.editReply({
        content: '_No hero data yet — stats appear after matches with uploaded reports._',
      });
      return;
    }

    const league = await prisma.league.findUnique({
      where: { id: resolved.leagueId },
      select: { name: true },
    });

    await interaction.editReply({
      embeds: [buildHeroAllEmbed(rankings, { leagueName: league?.name })],
      components: buildHeroAllPageButtons({
        invokerId: interaction.user.id,
        leagueId: resolved.leagueId,
        page: rankings.page,
        totalPages: rankings.totalPages,
        sort: rankings.sort,
        windows,
      }),
    });
  } catch (error) {
    log.error({ err: error }, 'hero_all command failed');
    await interaction.editReply({ content: 'Something went wrong loading hero rankings.' });
  }
}
