import { MessageFlags, type Interaction } from 'discord.js';
import { prisma } from '../../lib/prisma.js';
import { teamDisplayName } from '../../services/guild/index.js';
import { getGameProfileForLeague } from '../../services/league/index.js';
import {
  buildMatchHistoryEmbed,
  buildMatchHistoryPageButtons,
  loadMatchHistoryPage,
  parseMatchHistoryPageCustomId,
} from '../../services/match/index.js';

const NOT_YOUR_PAGE = 'Only the person who ran the history command can change pages.';

export async function handleMatchHistoryInteraction(interaction: Interaction): Promise<boolean> {
  if (!interaction.isButton()) {
    return false;
  }
  if (!interaction.customId.startsWith('mh:p:')) {
    return false;
  }

  const parsed = parseMatchHistoryPageCustomId(interaction.customId);
  if (!parsed) {
    return true;
  }

  if (interaction.user.id !== parsed.invokerId) {
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

  await interaction.deferUpdate();
  const pageData = await loadMatchHistoryPage({
    leagueId: parsed.leagueId,
    playerId: parsed.playerId,
    username: player.username,
    page: parsed.page,
    griefersOnly: parsed.griefersOnly,
  });
  const profile = await getGameProfileForLeague(parsed.leagueId);
  await interaction.editReply({
    embeds: [
      buildMatchHistoryEmbed(pageData, parsed.leagueId, (team) => teamDisplayName(team, profile), {
        showTeam: profile.matchHistoryShowsTeam,
      }),
    ],
    components: buildMatchHistoryPageButtons({
      invokerId: parsed.invokerId,
      playerId: parsed.playerId,
      leagueId: parsed.leagueId,
      page: pageData.page,
      totalPages: pageData.totalPages,
      griefersOnly: pageData.griefersOnly,
    }),
  });
  return true;
}
