import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  GameHeroCatalogError,
  renameGameHeroDisplayName,
} from '../../services/game/game-hero-catalog.js';
import { canConfigureBot, resolveGuildConfig } from '../../services/guild/index.js';
import {
  getGameProfileForLeague,
  getLeagueOption,
  resolveLeagueIdFromInteraction,
  respondLeagueAutocomplete,
  withSubcommandLeagueOption,
} from '../../services/league/index.js';
import { assertHasMatchModRole } from '../../services/match/match-auth.js';
import { MatchServiceError } from '../../services/match/index.js';
import { listWosHeroNamesForLeague } from '../../services/player/wos-hero-names.js';
import { memberPermissions, memberRoleIds } from '../config/config-shared.js';

const log = createLogger('hero_config_cmd');

const WOS_ONLY_MESSAGE = 'Hero display names are only available for WOS leagues.';

export const data = new SlashCommandBuilder()
  .setName('hero_config')
  .setDescription('Staff tools for WOS hero display names')
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('rename')
        .setDescription('Set a shorter display name for a WOS hero')
        .addStringOption((option) =>
          option
            .setName('hero')
            .setDescription('Current hero name')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addStringOption((option) =>
          option
            .setName('display_name')
            .setDescription('New display name shown to players')
            .setRequired(true),
        ),
    ),
  );

async function assertCanRenameGameHero(interaction: ChatInputCommandInteraction): Promise<void> {
  if (
    canConfigureBot({
      userId: interaction.user.id,
      memberPermissions: memberPermissions(interaction),
    })
  ) {
    return;
  }

  if (!interaction.guildId) {
    throw new MatchServiceError('This command can only be used in a server.');
  }

  const config = await resolveGuildConfig(interaction.guildId);
  assertHasMatchModRole({
    actorDiscordId: interaction.user.id,
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId: config.matchModRoleId,
  });
}

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
  const subcommand = interaction.options.getSubcommand();
  if (subcommand !== 'rename') {
    await interaction.reply({
      content: 'Unknown subcommand.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await assertCanRenameGameHero(interaction);

    const resolved = await resolveLeagueIdFromInteraction(
      interaction,
      getLeagueOption(interaction),
    );
    if (!resolved.ok) {
      await interaction.editReply({ content: resolved.message });
      return;
    }

    const profile = await getGameProfileForLeague(resolved.leagueId);
    if (profile.postMatchStats !== 'wos2_bot_v1') {
      await interaction.editReply({ content: WOS_ONLY_MESSAGE });
      return;
    }

    const heroName = interaction.options.getString('hero', true);
    const displayName = interaction.options.getString('display_name', true);

    const result = await renameGameHeroDisplayName({
      gameId: profile.gameId,
      leagueId: resolved.leagueId,
      currentName: heroName,
      displayName,
    });

    await interaction.editReply({
      content: `Hero display name updated to **${result.displayName}**.`,
    });
  } catch (error) {
    if (error instanceof GameHeroCatalogError || error instanceof MatchServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    log.error({ err: error }, 'hero_config rename failed');
    await interaction.editReply({ content: 'Something went wrong renaming the hero.' });
  }
}
