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
import {
  findPlayerForRankLookup,
  parseRankOptions,
  PlayerServiceError,
} from '../../services/player/index.js';
import { buildHeroStatsEmbed } from '../../services/player/hero-stats-embed.js';
import { loadHeroStats, parseStatsWindows } from '../../services/player/hero-stats.js';
import { listWosHeroNamesForLeague } from '../../services/player/wos-hero-names.js';

const log = createLogger('hero_cmd');

const WOS_STATS_ONLY_MESSAGE = 'Hero/item stats are only available for WOS leagues.';

export const data = withOptionalLeagueOption(
  new SlashCommandBuilder()
    .setName('hero')
    .setDescription('WOS hero stats — league averages and top players')
    .addStringOption((option) =>
      option.setName('hero').setDescription('Hero name').setRequired(true).setAutocomplete(true),
    )
    .addUserOption((option) =>
      option.setName('user').setDescription('Player to look up').setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('nick').setDescription('In-game nick to look up').setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('window')
        .setDescription('Stats window')
        .setRequired(false)
        .addChoices(
          { name: 'Both', value: 'both' },
          { name: 'Last 10', value: 'last10' },
          { name: 'Overall', value: 'overall' },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('recent')
        .setDescription('Recent games to show')
        .setRequired(false)
        .addChoices({ name: '5', value: '5' }, { name: '10', value: '10' }),
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
  const windowRaw = interaction.options.getString('window');
  const windows = parseStatsWindows(windowRaw === 'both' ? null : windowRaw);
  const recentRaw = interaction.options.getString('recent');
  const recentLimit = recentRaw === '10' ? 10 : 5;

  const lookup = parseRankOptions({
    selfDiscordId: interaction.user.id,
    userDiscordId: user?.id,
    nick,
  });

  const hasPlayerLookup = lookup.kind !== 'self';
  if (hasPlayerLookup) {
    await interaction.deferReply();
  }

  try {
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

    let playerId: string | undefined;
    let playerUsername: string | undefined;
    if (lookup.kind === 'both') {
      throw new PlayerServiceError('Provide either a Discord user or a nick, not both.');
    }
    if (lookup.kind !== 'self') {
      const player = await findPlayerForRankLookup(profile.gameId, lookup);
      if (!player) {
        throw new PlayerServiceError('Player not found.');
      }
      playerId = player.id;
      playerUsername = player.username;
    }

    if (!interaction.deferred) {
      await interaction.deferReply();
    }

    const stats = await loadHeroStats({
      leagueId: resolved.leagueId,
      gameId: profile.gameId,
      heroName,
      playerId,
      windows,
      recentLimit,
    });

    if (!stats) {
      const message = playerUsername
        ? `**${playerUsername}** has no recorded games on **${heroName}**.`
        : `No completed matches found for **${heroName}** in this league.`;
      await interaction.editReply({ content: message });
      return;
    }

    const league = await prisma.league.findUnique({
      where: { id: resolved.leagueId },
      select: { name: true },
    });

    await interaction.editReply({
      embeds: [buildHeroStatsEmbed(stats, { leagueName: league?.name })],
    });
  } catch (error) {
    if (error instanceof PlayerServiceError) {
      const payload = { content: error.message };
      if (interaction.deferred) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply({
          ...payload,
          ...(error.ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
        });
      }
      return;
    }
    log.error({ err: error }, 'hero command failed');
    const payload = { content: 'Something went wrong loading hero stats.' };
    if (interaction.deferred) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply(payload);
    }
  }
}
