import { MessageFlags, SlashCommandBuilder } from 'discord.js';
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
  const user = interaction.options.getUser('user');
  const nick = interaction.options.getString('nick');
  const lookup = parseRankOptions({
    selfDiscordId: interaction.user.id,
    userDiscordId: user?.id,
    nick,
  });

  // Self-unlinked must stay private; Discord locks visibility on the first response.
  if (lookup.kind !== 'self') {
    await interaction.deferReply();
  }

  try {
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

    const payload = { embeds: [buildRankEmbed(profile, { avatarUrl })] };
    if (interaction.deferred) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (error) {
    if (error instanceof PlayerServiceError) {
      await replyRankError(interaction, error.message, error.ephemeral);
      return;
    }
    log.error({ err: error }, 'rank command failed');
    await replyRankError(interaction, 'Something went wrong loading that rank.', false);
  }
}

async function replyRankError(
  interaction: ChatInputCommandInteraction,
  content: string,
  ephemeral: boolean,
) {
  if (interaction.deferred) {
    await interaction.editReply({ content });
    return;
  }
  await interaction.reply({
    content,
    ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  });
}
