import { SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  loadPlayerProfile,
  parseRankOptions,
  PlayerServiceError,
} from '../../services/player-profile.js';
import { buildRankEmbed } from '../../services/rank-embed.js';

const log = createLogger('rank_cmd');

export const data = new SlashCommandBuilder()
  .setName('rank')
  .setDescription('Show your rank profile or look up another player')
  .addUserOption((option) =>
    option
      .setName('user')
      .setDescription('Discord user to look up')
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName('nick')
      .setDescription('In-game nick to look up')
      .setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const user = interaction.options.getUser('user');
  const nick = interaction.options.getString('nick');

  try {
    const lookup = parseRankOptions({
      selfDiscordId: interaction.user.id,
      userDiscordId: user?.id,
      nick,
    });
    const profile = await loadPlayerProfile(lookup);

    let avatarUrl: string | null = null;
    if (profile.discordId) {
      if (user && user.id === profile.discordId) {
        avatarUrl = user.displayAvatarURL({ size: 128 });
      } else if (profile.discordId === interaction.user.id) {
        avatarUrl = interaction.user.displayAvatarURL({ size: 128 });
      } else {
        try {
          const fetched = await interaction.client.users.fetch(profile.discordId);
          avatarUrl = fetched.displayAvatarURL({ size: 128 });
        } catch {
          avatarUrl = null;
        }
      }
    }

    await interaction.editReply({
      embeds: [buildRankEmbed(profile, { avatarUrl })],
    });
  } catch (error) {
    if (error instanceof PlayerServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    log.error({ err: error }, 'rank command failed');
    await interaction.editReply({ content: 'Something went wrong loading that rank.' });
  }
}
