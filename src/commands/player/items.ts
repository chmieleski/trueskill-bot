import { MessageFlags, SlashCommandBuilder } from 'discord.js';
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
import { buildItemStatsEmbed } from '../../services/player/item-stats-embed.js';
import { loadItemStats } from '../../services/player/item-stats.js';
import { parseStatsWindows } from '../../services/player/hero-stats.js';
import { listWosHeroNamesForLeague } from '../../services/player/wos-hero-names.js';

const log = createLogger('items_cmd');

const WOS_STATS_ONLY_MESSAGE = 'Hero/item stats are only available for WOS leagues.';

export const data = withOptionalLeagueOption(
  new SlashCommandBuilder()
    .setName('items')
    .setDescription('WOS item buy rate and win rate')
    .addStringOption((option) =>
      option
        .setName('hero')
        .setDescription('Filter to one hero')
        .setRequired(false)
        .setAutocomplete(true),
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

  try {
    const profile = await getGameProfileForLeague(resolved.leagueId);
    if (profile.postMatchStats !== 'wos2_bot_v1') {
      await interaction.respond([]);
      return;
    }
  } catch {
    await interaction.respond([]);
    return;
  }

  const heroes = await listWosHeroNamesForLeague(resolved.leagueId);
  const query = focused.value.toLowerCase();
  const choices = heroes
    .filter((hero) => hero.toLowerCase().includes(query))
    .slice(0, 25)
    .map((hero) => ({ name: hero.slice(0, 100), value: hero.slice(0, 100) }));

  await interaction.respond(choices);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const heroName = interaction.options.getString('hero');
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

    const league = await prisma.league.findUnique({
      where: { id: resolved.leagueId },
      select: { name: true, gameId: true },
    });
    if (!league) {
      await interaction.editReply({ content: 'League not found.' });
      return;
    }

    const stats = await loadItemStats({
      leagueId: resolved.leagueId,
      gameId: league.gameId,
      heroName: heroName ?? undefined,
      windows,
    });

    const hasData = Object.values(stats.windows).some((entries) => entries && entries.length > 0);
    if (!hasData) {
      await interaction.editReply({
        content: '_No item data yet — stats appear after matches with uploaded reports._',
      });
      return;
    }

    await interaction.editReply({
      embeds: [buildItemStatsEmbed(stats, { leagueName: league.name })],
    });
  } catch (error) {
    log.error({ err: error }, 'items command failed');
    await interaction.editReply({ content: 'Something went wrong loading item stats.' });
  }
}
