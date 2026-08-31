import { MessageFlags, type Interaction } from 'discord.js';
import { prisma } from '../../lib/prisma.js';
import { getGameProfileForLeague } from '../../services/league/index.js';
import {
  buildHeroMatchesEmbed,
  buildHeroMatchesPageButtons,
  loadHeroMatchesPage,
  parseHeroMatchesPageCustomId,
  resolveHeroMatchesHeroToken,
} from '../../services/player/hero-matches.js';

const NOT_YOUR_PAGE = 'Only the person who ran the hero matches command can change pages.';

export async function handleHeroMatchesInteraction(interaction: Interaction): Promise<boolean> {
  if (!interaction.isButton()) {
    return false;
  }
  if (!interaction.customId.startsWith('hm:')) {
    return false;
  }

  const parsed = parseHeroMatchesPageCustomId(interaction.customId);
  if (!parsed) {
    return true;
  }

  const ownerId = interaction.message.interaction?.user.id;
  if (!ownerId || interaction.user.id !== ownerId) {
    await interaction.reply({ content: NOT_YOUR_PAGE, flags: MessageFlags.Ephemeral });
    return true;
  }

  const player = await prisma.player.findUnique({ where: { id: parsed.playerId } });
  if (!player) {
    await interaction.reply({
      content: 'Player not found.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const profile = await getGameProfileForLeague(parsed.leagueId);
  const selection = await resolveHeroMatchesHeroToken(
    profile.gameId,
    parsed.leagueId,
    parsed.heroToken,
  );
  if (!selection) {
    await interaction.reply({
      content: 'Hero not found.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.deferUpdate();
  const pageData = await loadHeroMatchesPage({
    leagueId: parsed.leagueId,
    gameId: profile.gameId,
    selection,
    playerId: parsed.playerId,
    username: player.username,
    page: parsed.page,
  });

  const league = await prisma.league.findUnique({
    where: { id: parsed.leagueId },
    select: { name: true },
  });

  await interaction.editReply({
    embeds: [buildHeroMatchesEmbed(pageData, { leagueName: league?.name })],
    components: buildHeroMatchesPageButtons({
      playerId: parsed.playerId,
      leagueId: parsed.leagueId,
      heroToken: parsed.heroToken,
      page: pageData.page,
      totalPages: pageData.totalPages,
    }),
  });
  return true;
}
