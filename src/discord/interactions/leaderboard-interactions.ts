import { MessageFlags, type Interaction } from 'discord.js';
import {
  loadOverallLeaderboardPage,
  loadQuitterLeaderboardPage,
} from '../../services/leaderboard/index.js';
import {
  buildLeaderboardPageButtons,
  buildOverallLeaderboardEmbed,
  buildQuitterLeaderboardEmbed,
  buildQuitterPageButtons,
  parseLeaderboardPageCustomId,
  parseQuitterPageCustomId,
} from '../../services/leaderboard/index.js';

const NOT_YOUR_PAGE =
  'Only the person who ran the leaderboard command can change pages.';

export async function handleLeaderboardInteraction(
  interaction: Interaction,
): Promise<boolean> {
  if (!interaction.isButton()) {
    return false;
  }

  if (interaction.customId.startsWith('lb:quitters:')) {
    const parsed = parseQuitterPageCustomId(interaction.customId);
    if (!parsed) return true;
    if (interaction.user.id !== parsed.invokerId) {
      await interaction.reply({ content: NOT_YOUR_PAGE, flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!interaction.guildId) return true;
    // Defer before the history scan so Discord does not time out the button.
    await interaction.deferUpdate();
    const pageData = await loadQuitterLeaderboardPage(interaction.guildId, parsed.page);
    await interaction.editReply({
      embeds: [buildQuitterLeaderboardEmbed(pageData)],
      components: buildQuitterPageButtons({
        invokerId: parsed.invokerId,
        page: pageData.page,
        totalPages: pageData.totalPages,
      }),
    });
    return true;
  }

  if (!interaction.customId.startsWith('leaderboard:')) {
    return false;
  }

  const parsed = parseLeaderboardPageCustomId(interaction.customId);
  if (!parsed) {
    return true;
  }

  if (interaction.user.id !== parsed.invokerId) {
    await interaction.reply({ content: NOT_YOUR_PAGE, flags: MessageFlags.Ephemeral });
    return true;
  }

  const pageData = await loadOverallLeaderboardPage(parsed.leagueId, parsed.page);
  const embed = buildOverallLeaderboardEmbed(pageData);
  const components = buildLeaderboardPageButtons({
    invokerId: parsed.invokerId,
    leagueId: parsed.leagueId,
    page: pageData.page,
    totalPages: pageData.totalPages,
  });

  await interaction.update({ embeds: [embed], components });
  return true;
}
