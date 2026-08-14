import {
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
} from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { assertCanConfigureBot } from '../../services/guild-config.js';
import { setupLiveLeaderboard } from '../../services/leaderboard-channel.js';
import { HeroCatalogError, listHeroNames, resolveHeroByName } from '../../services/hero-catalog.js';
import {
  HERO_SINGLE_TOP,
  LeaderboardServiceError,
  loadAllHeroLeaderboards,
  loadHeroLeaderboard,
  loadOverallLeaderboardPage,
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
      .setDescription('Global overall leaderboard (top 10 per page)')
      .addIntegerOption((option) =>
        option
          .setName('page')
          .setDescription('Page number')
          .setRequired(false)
          .setMinValue(1),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('heroes')
      .setDescription('Top 3 players for each configured hero'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('hero')
      .setDescription('Top 10 players for one hero')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Hero name (e.g. Goku)')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('setup')
      .setDescription('Post a live overall top-10 message in this channel'),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (interaction.options.getSubcommand() !== 'hero') {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'name') {
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

  if (subcommand === 'show') {
    await handleShowOverall(interaction);
    return;
  }

  if (subcommand === 'heroes') {
    await handleShowAllHeroes(interaction);
    return;
  }

  if (subcommand === 'hero') {
    await handleShowSingleHero(interaction);
    return;
  }

  await interaction.editReply({ content: 'Unknown leaderboard subcommand.' });
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

async function handleShowOverall(interaction: ChatInputCommandInteraction): Promise<void> {
  const requestedPage = interaction.options.getInteger('page') ?? 1;

  try {
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
    log.error({ err: error }, 'leaderboard show failed');
    await interaction.editReply({ content: 'Something went wrong loading the leaderboard.' });
  }
}

async function handleShowAllHeroes(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const slices = await loadAllHeroLeaderboards();
    if (slices.length === 0) {
      await interaction.editReply({
        content: 'No heroes are configured for this server. Add a hero roster in the database first.',
      });
      return;
    }
    await interaction.editReply({ embeds: [buildAllHeroLeaderboardsEmbed(slices)] });
  } catch (error) {
    log.error({ err: error }, 'leaderboard heroes failed');
    await interaction.editReply({ content: 'Something went wrong loading hero leaderboards.' });
  }
}

async function handleShowSingleHero(interaction: ChatInputCommandInteraction): Promise<void> {
  const heroName = interaction.options.getString('name', true);

  try {
    const resolved = await resolveHeroByName(heroName);
    if (!resolved) {
      await interaction.editReply({ content: 'Unknown hero.' });
      return;
    }

    const board = await loadHeroLeaderboard(resolved.heroId, HERO_SINGLE_TOP);
    await interaction.editReply({
      embeds: [buildHeroLeaderboardEmbed(board.heroName, board.entries)],
    });
  } catch (error) {
    if (error instanceof HeroCatalogError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    if (error instanceof LeaderboardServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    log.error({ err: error, heroName }, 'leaderboard hero failed');
    await interaction.editReply({ content: 'Something went wrong loading that hero leaderboard.' });
  }
}
