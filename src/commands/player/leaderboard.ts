import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { assertCanConfigureBot } from '../../services/guild/index.js';
import {
  setupLiveLeaderboard,
  setupGrieferLiveLeaderboard,
  setupQuitterLiveLeaderboard,
} from '../../services/leaderboard/index.js';
import { HeroCatalogError, listHeroNames, resolveHeroByName } from '../../services/guild/index.js';
import {
  HERO_SINGLE_TOP,
  LeaderboardServiceError,
  loadAllHeroLeaderboards,
  loadHeroLeaderboard,
  loadOverallLeaderboardPage,
  loadGrieferLeaderboardPage,
  loadQuitterLeaderboardPage,
} from '../../services/leaderboard/index.js';
import {
  buildAllHeroLeaderboardsEmbed,
  buildGrieferLeaderboardEmbed,
  buildGrieferPageButtons,
  buildHeroLeaderboardEmbed,
  buildLeaderboardPageButtons,
  buildOverallLeaderboardEmbed,
  buildQuitterLeaderboardEmbed,
  buildQuitterPageButtons,
} from '../../services/leaderboard/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import {
  getGameProfileForLeague,
  getLeagueById,
  getLeagueOption,
  isLeagueWritable,
  LEAGUE_ARCHIVED_MESSAGE,
  resolveLeagueIdFromInteraction,
  respondAllLeagueAutocomplete,
  respondLeagueAutocomplete,
  withSubcommandLeagueOption,
} from '../../services/league/index.js';

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
    withSubcommandLeagueOption(
      subcommand
        .setName('show')
        .setDescription('Global overall leaderboard (top 10 per page)')
        .addIntegerOption((option) =>
          option.setName('page').setDescription('Page number').setRequired(false).setMinValue(1),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand.setName('heroes').setDescription('Top 3 players for each configured hero'),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
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
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('setup')
        .setDescription('Post a live overall top-10 message in this channel'),
    ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('quitters')
      .setDescription('Guild quitter leaderboard (top 10 per page)')
      .addIntegerOption((option) =>
        option.setName('page').setDescription('Page number').setRequired(false).setMinValue(1),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('setup_quitters')
      .setDescription('Post a live quitter leaderboard message in this channel'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('griefers')
      .setDescription('Guild griefer leaderboard (top 10 per page)')
      .addIntegerOption((option) =>
        option.setName('page').setDescription('Page number').setRequired(false).setMinValue(1),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('setup_griefers')
      .setDescription('Post a live griefer leaderboard message in this channel'),
  );

const LEADERBOARD_HISTORY_SUBCOMMANDS = new Set(['show', 'heroes', 'hero', 'quitters', 'griefers']);

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);
  const leagueAutocomplete =
    subcommand && LEADERBOARD_HISTORY_SUBCOMMANDS.has(subcommand)
      ? respondAllLeagueAutocomplete
      : respondLeagueAutocomplete;

  if (await leagueAutocomplete(interaction)) {
    return;
  }

  if (interaction.options.getSubcommand() !== 'hero') {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'name') {
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
    if (profile.heroBinding === 'optional_in_game') {
      await interaction.respond([]);
      return;
    }
  } catch (error) {
    log.warn({ err: error }, 'leaderboard hero autocomplete profile lookup failed');
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

  if (subcommand === 'setup_quitters') {
    await handleSetupQuitters(interaction);
    return;
  }

  if (subcommand === 'setup_griefers') {
    await handleSetupGriefers(interaction);
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

  if (subcommand === 'quitters') {
    await handleShowQuitters(interaction);
    return;
  }

  if (subcommand === 'griefers') {
    await handleShowGriefers(interaction);
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

  const resolved = await resolveLeagueIdFromInteraction(interaction, getLeagueOption(interaction));
  if (!resolved.ok) {
    await interaction.reply({ content: resolved.message, flags: MessageFlags.Ephemeral });
    return;
  }

  const league = await getLeagueById(resolved.leagueId);
  if (!league || !isLeagueWritable(league)) {
    await interaction.reply({
      content: LEAGUE_ARCHIVED_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await setupLiveLeaderboard(interaction.client, resolved.leagueId, interaction.channelId);
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

/** Post a guild-wide live quitter leaderboard in the current channel. */
async function handleSetupQuitters(interaction: ChatInputCommandInteraction): Promise<void> {
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
    await setupQuitterLiveLeaderboard(
      interaction.client,
      interaction.guildId,
      interaction.channelId,
    );
    await interaction.reply({
      content: 'Live quitter leaderboard set in this channel. Keep only this message here.',
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    log.error({ err: error, guildId: interaction.guildId }, 'leaderboard setup_quitters failed');
    await interaction.reply({
      content: 'Something went wrong setting up the live quitter leaderboard.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

/** Post a guild-wide live griefer leaderboard in the current channel. */
async function handleSetupGriefers(interaction: ChatInputCommandInteraction): Promise<void> {
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
    await setupGrieferLiveLeaderboard(
      interaction.client,
      interaction.guildId,
      interaction.channelId,
    );
    await interaction.reply({
      content: 'Live griefer leaderboard set in this channel. Keep only this message here.',
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    log.error({ err: error, guildId: interaction.guildId }, 'leaderboard setup_griefers failed');
    await interaction.reply({
      content: 'Something went wrong setting up the live griefer leaderboard.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function resolveLeagueOrReply(
  interaction: ChatInputCommandInteraction,
): Promise<string | null> {
  const resolved = await resolveLeagueIdFromInteraction(interaction, getLeagueOption(interaction));

  if (!resolved.ok) {
    await interaction.editReply({ content: resolved.message });
    return null;
  }

  return resolved.leagueId;
}

async function handleShowOverall(interaction: ChatInputCommandInteraction): Promise<void> {
  const requestedPage = interaction.options.getInteger('page') ?? 1;

  try {
    const leagueId = await resolveLeagueOrReply(interaction);
    if (!leagueId) return;

    const firstPage = await loadOverallLeaderboardPage(leagueId, 1);
    if (requestedPage > firstPage.totalPages) {
      await interaction.editReply({
        content: `Page must be between 1 and ${firstPage.totalPages}.`,
      });
      return;
    }

    const pageData =
      requestedPage === 1 ? firstPage : await loadOverallLeaderboardPage(leagueId, requestedPage);
    const gameProfile = await getGameProfileForLeague(leagueId);
    const embed = buildOverallLeaderboardEmbed(pageData, {
      ratingLabel: gameProfile.ratingLabel,
    });
    const components = buildLeaderboardPageButtons({
      invokerId: interaction.user.id,
      leagueId,
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
    const leagueId = await resolveLeagueOrReply(interaction);
    if (!leagueId) return;

    const profile = await getGameProfileForLeague(leagueId);
    if (profile.heroBinding === 'optional_in_game') {
      await interaction.editReply({
        content: 'Hero rankings are not available for this game.',
      });
      return;
    }

    const slices = await loadAllHeroLeaderboards(leagueId);
    if (slices.length === 0) {
      await interaction.editReply({
        content:
          'No heroes are configured for this server. Add a hero roster in the database first.',
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
    const leagueId = await resolveLeagueOrReply(interaction);
    if (!leagueId) return;

    const profile = await getGameProfileForLeague(leagueId);
    if (profile.heroBinding === 'optional_in_game') {
      await interaction.editReply({
        content: 'Hero rankings are not available for this game.',
      });
      return;
    }

    const resolved = await resolveHeroByName(heroName);
    if (!resolved) {
      await interaction.editReply({ content: 'Unknown hero.' });
      return;
    }

    const board = await loadHeroLeaderboard(leagueId, resolved.heroId, HERO_SINGLE_TOP);
    await interaction.editReply({
      embeds: [buildHeroLeaderboardEmbed(board.heroName, board.entries, profile.ratingLabel)],
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

/** Paginated guild-wide quitter leaderboard (no league option). */
async function handleShowQuitters(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.editReply({ content: 'This command can only be used in a server.' });
    return;
  }

  const requestedPage = interaction.options.getInteger('page') ?? 1;

  try {
    const firstPage = await loadQuitterLeaderboardPage(interaction.guildId, 1);
    if (requestedPage > firstPage.totalPages) {
      await interaction.editReply({
        content: `Page must be between 1 and ${firstPage.totalPages}.`,
      });
      return;
    }

    const pageData =
      requestedPage === 1
        ? firstPage
        : await loadQuitterLeaderboardPage(interaction.guildId, requestedPage);
    const embed = buildQuitterLeaderboardEmbed(pageData);
    const components = buildQuitterPageButtons({
      invokerId: interaction.user.id,
      page: pageData.page,
      totalPages: pageData.totalPages,
    });

    await interaction.editReply({ embeds: [embed], components });
  } catch (error) {
    log.error({ err: error }, 'leaderboard quitters failed');
    await interaction.editReply({
      content: 'Something went wrong loading the quitter leaderboard.',
    });
  }
}

/** Paginated guild-wide griefer leaderboard (no league option). */
async function handleShowGriefers(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.editReply({ content: 'This command can only be used in a server.' });
    return;
  }

  const requestedPage = interaction.options.getInteger('page') ?? 1;

  try {
    const firstPage = await loadGrieferLeaderboardPage(interaction.guildId, 1);
    if (requestedPage > firstPage.totalPages) {
      await interaction.editReply({
        content: `Page must be between 1 and ${firstPage.totalPages}.`,
      });
      return;
    }

    const pageData =
      requestedPage === 1
        ? firstPage
        : await loadGrieferLeaderboardPage(interaction.guildId, requestedPage);
    const embed = buildGrieferLeaderboardEmbed(pageData);
    const components = buildGrieferPageButtons({
      invokerId: interaction.user.id,
      page: pageData.page,
      totalPages: pageData.totalPages,
    });

    await interaction.editReply({ embeds: [embed], components });
  } catch (error) {
    log.error({ err: error }, 'leaderboard griefers failed');
    await interaction.editReply({
      content: 'Something went wrong loading the griefer leaderboard.',
    });
  }
}
