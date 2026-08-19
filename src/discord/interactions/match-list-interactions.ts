import { MessageFlags, type Interaction } from 'discord.js';
import { teamDisplayName } from '../../services/guild/index.js';
import { getGameProfileForLeague } from '../../services/league/index.js';
import {
  buildMatchListEmbed,
  buildMatchListPageButtons,
  loadMatchListPage,
  parseMatchListPageCustomId,
} from '../../services/match/index.js';

const NOT_YOUR_PAGE = 'Only the person who ran the command can change pages.';

export async function handleMatchListInteraction(
  interaction: Interaction,
): Promise<boolean> {
  if (!interaction.isButton()) {
    return false;
  }
  if (!interaction.customId.startsWith('ml:p:')) {
    return false;
  }

  const parsed = parseMatchListPageCustomId(interaction.customId);
  if (!parsed) {
    return true;
  }

  if (interaction.user.id !== parsed.invokerId) {
    await interaction.reply({ content: NOT_YOUR_PAGE, flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.deferUpdate();
  const pageData = await loadMatchListPage({
    leagueId: parsed.leagueId,
    page: parsed.page,
  });
  const profile = await getGameProfileForLeague(parsed.leagueId);
  await interaction.editReply({
    embeds: [
      buildMatchListEmbed(pageData, (team) => teamDisplayName(team, profile)),
    ],
    components: buildMatchListPageButtons({
      invokerId: parsed.invokerId,
      leagueId: parsed.leagueId,
      page: pageData.page,
      totalPages: pageData.totalPages,
    }),
  });
  return true;
}
