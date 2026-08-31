import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import {
  getGameProfileForLeague,
  getLeagueOption,
  resolveLeagueIdFromInteraction,
  respondLeagueAutocomplete,
  withOptionalLeagueOption,
} from '../../services/league/index.js';
import { resolveHistoryPlayer, MatchServiceError } from '../../services/match/index.js';
import { resolveHeroSelection } from '../../services/game/game-hero-catalog.js';
import {
  buildHeroMatchesEmbed,
  buildHeroMatchesPageButtons,
  encodeHeroMatchesHeroToken,
  loadHeroMatchesPage,
} from '../../services/player/hero-matches.js';
import { parseRankOptions, PlayerServiceError } from '../../services/player/index.js';
import { listWosHeroNamesForLeague } from '../../services/player/wos-hero-names.js';

const log = createLogger('hero_matches_cmd');

const WOS_STATS_ONLY_MESSAGE = 'Hero match history is only available for WOS leagues.';

export const data = withOptionalLeagueOption(
  new SlashCommandBuilder()
    .setName('hero_matches')
    .setDescription('List all match ids for a player on a WOS hero (paginated)')
    .addStringOption((option) =>
      option.setName('hero').setDescription('Hero name').setRequired(true).setAutocomplete(true),
    )
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Player to look up (defaults to you)')
        .setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('nick').setDescription('In-game nick to look up').setRequired(false),
    )
    .addIntegerOption((option) =>
      option.setName('page').setDescription('Page number').setRequired(false).setMinValue(1),
    ),
);

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (await respondLeagueAutocomplete(interaction)) {
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'hero') {
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

  let gameId: string;
  try {
    const profile = await getGameProfileForLeague(resolved.leagueId);
    if (profile.postMatchStats !== 'wos2_bot_v1') {
      await interaction.respond([]);
      return;
    }
    gameId = profile.gameId;
  } catch {
    await interaction.respond([]);
    return;
  }

  const heroes = await listWosHeroNamesForLeague(resolved.leagueId, gameId);
  const query = focused.value.toLowerCase();
  const choices = heroes
    .filter((hero) => hero.toLowerCase().includes(query))
    .slice(0, 25)
    .map((hero) => ({ name: hero.slice(0, 100), value: hero.slice(0, 100) }));

  await interaction.respond(choices);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const heroName = interaction.options.getString('hero', true);
  const user = interaction.options.getUser('user');
  const nick = interaction.options.getString('nick');
  const pageNum = interaction.options.getInteger('page') ?? 1;

  const lookup = parseRankOptions({
    selfDiscordId: interaction.user.id,
    userDiscordId: user?.id,
    nick,
  });

  const isSelfLookup = lookup.kind === 'self';
  if (!isSelfLookup) {
    await interaction.deferReply();
  }

  try {
    if (!interaction.guildId) {
      throw new PlayerServiceError('This command can only be used in a server.');
    }

    const resolved = await resolveLeagueIdFromInteraction(
      interaction,
      getLeagueOption(interaction),
    );
    if (!resolved.ok) {
      const payload = { content: resolved.message };
      if (interaction.deferred) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    const profile = await getGameProfileForLeague(resolved.leagueId);
    if (profile.postMatchStats !== 'wos2_bot_v1') {
      const payload = { content: WOS_STATS_ONLY_MESSAGE };
      if (interaction.deferred) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (lookup.kind === 'both') {
      throw new PlayerServiceError('Provide either a Discord user or a nick, not both.');
    }

    const player = await resolveHistoryPlayer(profile.gameId, lookup);
    const selection = await resolveHeroSelection(profile.gameId, resolved.leagueId, heroName);
    if (!selection) {
      throw new PlayerServiceError(`Unknown hero **${heroName}** in this league.`);
    }

    if (!interaction.deferred) {
      await interaction.deferReply();
    }

    const pageData = await loadHeroMatchesPage({
      leagueId: resolved.leagueId,
      gameId: profile.gameId,
      selection,
      playerId: player.id,
      username: player.username,
      page: pageNum,
    });

    const league = await prisma.league.findUnique({
      where: { id: resolved.leagueId },
      select: { name: true },
    });

    const heroToken = encodeHeroMatchesHeroToken(selection);
    await interaction.editReply({
      embeds: [buildHeroMatchesEmbed(pageData, { leagueName: league?.name })],
      components: buildHeroMatchesPageButtons({
        playerId: player.id,
        leagueId: resolved.leagueId,
        heroToken,
        page: pageData.page,
        totalPages: pageData.totalPages,
      }),
    });
  } catch (error) {
    if (error instanceof PlayerServiceError || error instanceof MatchServiceError) {
      const payload = { content: error.message };
      if (interaction.deferred) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply({
          ...payload,
          ...(error instanceof PlayerServiceError && error.ephemeral
            ? { flags: MessageFlags.Ephemeral }
            : {}),
        });
      }
      return;
    }

    log.error({ err: error }, 'hero_matches command failed');
    const payload = { content: 'Something went wrong loading hero match history.' };
    if (interaction.deferred) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply(payload);
    }
  }
}
