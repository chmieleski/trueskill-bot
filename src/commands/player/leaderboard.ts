import {
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
} from 'discord.js';
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
} from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { assertCanConfigureBot } from '../../services/guild-config.js';
import { setupLiveLeaderboard } from '../../services/leaderboard-channel.js';
import {
  HERO_SINGLE_TOP,
  LeaderboardServiceError,
  loadAllHeroLeaderboards,
  loadHeroLeaderboard,
  loadOverallLeaderboardPage,
  listHeroNames,
  resolveHeroByName,
} from '../../services/leaderboard.js';
import {
  buildAllHeroLeaderboardsEmbed,
  buildHeroLeaderboardEmbed,
  buildLeaderboardPageButtons,
  buildOverallLeaderboardEmbed,
} from '../../services/leaderboard-embed.js';
import { MatchServiceError } from '../../services/match-service.js';

const log = createLogger('leaderboard_cmd');

function memberPermissions(interaction: ChatInputCommandInteraction) {
  const member = interaction.member;

  if (member instanceof GuildMember) {
    return member.permissions;
  }

  if (member && typeof member === 'object' && 'permissions' in member) {
    return (member as { permissions: string }).permissions;
  }

  return null;
}

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('View global and hero leaderboards')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('show')
      .setDescription('Show overall or hero leaderboards')
      .addStringOption((option) =>
        option
          .setName('type')
          .setDescription('Leaderboard type')
          .setRequired(false)
          .addChoices(
            { name: 'Overall', value: 'overall' },
            { name: 'Hero', value: 'hero' },
          ),
      )
      .addStringOption((option) =>
        option
          .setName('hero')
          .setDescription('Hero name (top 10); omit for all heroes')
          .setRequired(false)
          .setAutocomplete(true),
      )
      .addIntegerOption((option) =>
        option
          .setName('page')
          .setDescription('Page number (overall only)')
          .setRequired(false)
          .setMinValue(1),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('setup')
      .setDescription('Post a live overall top-10 message in this channel'),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'hero') {
    await interaction.respond([]);
    return;
  }

  const heroes = await listHeroNames();
  const query = focused.value.toLowerCase();
  const choices = heroes
    .filter((hero) => hero.name.toLowerCase().includes(query))
    .slice(0, 25)
    .map((hero) => ({ name: hero.name, value: hero.name }));

  await interaction.respond(choices);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(true);

  if (subcommand === 'setup') {
    await handleSetup(interaction);
    return;
  }

  await interaction.deferReply();
  await handleShow(interaction);
}

async function handleSetup(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.channelId) {
    await interaction.reply({
      content: 'This command can only be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    assertCanConfigureBot({
      userId: interaction.user.id,
      memberPermissions: memberPermissions(interaction),
    });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral });
      return;
    }
    throw error;
  }

  try {
    await setupLiveLeaderboard(interaction.client, interaction.guildId, interaction.channelId);
    await interaction.reply({
      content: 'Live overall leaderboard set in this channel. Keep only this message here.',
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    log.error({ err: error, guildId: interaction.guildId }, 'leaderboard setup failed');
    await interaction.reply({
      content: 'Something went wrong setting up the live leaderboard.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleShow(interaction: ChatInputCommandInteraction): Promise<void> {
  const type = interaction.options.getString('type') ?? 'overall';
  const heroName = interaction.options.getString('hero');
  const requestedPage = interaction.options.getInteger('page') ?? 1;

  try {
    if (type === 'hero') {
      if (heroName) {
        const resolved = await resolveHeroByName(heroName);
        if (!resolved) {
          await interaction.editReply({ content: 'Unknown hero.' });
          return;
        }
        const board = await loadHeroLeaderboard(resolved.heroId, HERO_SINGLE_TOP);
        await interaction.editReply({
          embeds: [buildHeroLeaderboardEmbed(board.heroName, board.entries)],
        });
        return;
      }

      const slices = await loadAllHeroLeaderboards();
      await interaction.editReply({ embeds: [buildAllHeroLeaderboardsEmbed(slices)] });
      return;
    }

    const firstPage = await loadOverallLeaderboardPage(1);
    if (requestedPage > firstPage.totalPages) {
      await interaction.editReply({
        content: `Page must be between 1 and ${firstPage.totalPages}.`,
      });
      return;
    }

    const pageData =
      requestedPage === 1 ? firstPage : await loadOverallLeaderboardPage(requestedPage);
    const embed = buildOverallLeaderboardEmbed(pageData);
    const components = buildLeaderboardPageButtons({
      invokerId: interaction.user.id,
      page: pageData.page,
      totalPages: pageData.totalPages,
    });

    await interaction.editReply({ embeds: [embed], components });
  } catch (error) {
    if (error instanceof LeaderboardServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    log.error({ err: error }, 'leaderboard show failed');
    await interaction.editReply({ content: 'Something went wrong loading the leaderboard.' });
  }
}
