import { MessageFlags, type Interaction } from 'discord.js';
import { prisma } from '../../lib/prisma.js';
import { getGameProfileForLeague } from '../../services/league/index.js';
import {
  buildHeroAllEmbed,
  buildHeroAllPageButtons,
  parseHeroAllPageCustomId,
} from '../../services/player/hero-all-embed.js';
import { loadAllHeroRankings } from '../../services/player/hero-stats.js';

const NOT_YOUR_PAGE = 'Only the person who ran the hero rankings command can change pages.';
const WOS_STATS_ONLY_MESSAGE = 'Hero/item stats are only available for WOS leagues.';

export async function handleHeroAllInteraction(interaction: Interaction): Promise<boolean> {
  if (!interaction.isButton() || !interaction.customId.startsWith('ha:')) {
    return false;
  }

  const parsed = parseHeroAllPageCustomId(interaction.customId);
  if (!parsed) {
    return true;
  }

  if (interaction.user.id !== parsed.invokerId) {
    await interaction.reply({ content: NOT_YOUR_PAGE, flags: MessageFlags.Ephemeral });
    return true;
  }

  const profile = await getGameProfileForLeague(parsed.leagueId);
  if (profile.postMatchStats !== 'wos2_bot_v1') {
    await interaction.reply({ content: WOS_STATS_ONLY_MESSAGE, flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.deferUpdate();

  const rankings = await loadAllHeroRankings({
    leagueId: parsed.leagueId,
    gameId: profile.gameId,
    sort: parsed.sort,
    windows: parsed.windows,
    page: parsed.page,
  });

  const league = await prisma.league.findUnique({
    where: { id: parsed.leagueId },
    select: { name: true },
  });

  await interaction.editReply({
    embeds: [buildHeroAllEmbed(rankings, { leagueName: league?.name })],
    components: buildHeroAllPageButtons({
      invokerId: parsed.invokerId,
      leagueId: parsed.leagueId,
      page: rankings.page,
      totalPages: rankings.totalPages,
      sort: rankings.sort,
      windows: parsed.windows,
    }),
  });

  return true;
}
