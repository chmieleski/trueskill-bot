import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { resolveGuildConfig } from '../../services/guild/index.js';
import {
  getGameProfileForLeague,
  getLeagueOption,
  resolveLeagueIdFromInteraction,
  respondLeagueAutocomplete,
  withSubcommandLeagueOption,
} from '../../services/league/index.js';
import { assertHasMatchModRole, MatchServiceError } from '../../services/match/index.js';
import {
  ensurePlayerForModLookup,
  parseRankOptions,
  PlayerServiceError,
} from '../../services/player/index.js';
import { clearPlayerNewFlag, setPlayerNewFlag } from '../../services/rating/index.js';

const log = createLogger('player_new_cmd');

function memberRoleIds(interaction: { member: unknown }): string[] {
  const member = interaction.member;
  if (member instanceof GuildMember) {
    return [...member.roles.cache.keys()];
  }
  if (member && typeof member === 'object' && 'roles' in member) {
    const roles = (member as { roles: unknown }).roles;
    if (Array.isArray(roles)) {
      return roles;
    }
    if (roles && typeof roles === 'object' && 'cache' in roles) {
      const cache = (roles as { cache?: Map<string, unknown> }).cache;
      if (cache instanceof Map) {
        return [...cache.keys()];
      }
    }
  }
  return [];
}

export const data = new SlashCommandBuilder()
  .setName('player_new')
  .setDescription('Set or clear the New-player rating flag (moderators)')
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('set')
        .setDescription('Mark a player as New for this league')
        .addStringOption((option) =>
          option.setName('nick').setDescription('In-game nick').setRequired(false),
        )
        .addUserOption((option) =>
          option.setName('user').setDescription('Discord user').setRequired(false),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('clear')
        .setDescription('Remove the New flag from a player in this league')
        .addStringOption((option) =>
          option.setName('nick').setDescription('In-game nick').setRequired(false),
        )
        .addUserOption((option) =>
          option.setName('user').setDescription('Discord user').setRequired(false),
        ),
    ),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondLeagueAutocomplete(interaction);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const subcommand = interaction.options.getSubcommand(true);
  const nick = interaction.options.getString('nick');
  const user = interaction.options.getUser('user');

  try {
    if (!interaction.guildId) {
      await interaction.editReply({ content: 'This command can only be used in a server.' });
      return;
    }

    const config = await resolveGuildConfig(interaction.guildId);
    assertHasMatchModRole({
      actorDiscordId: interaction.user.id,
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: config.matchModRoleId,
    });

    // Require exactly one of nick | user (do not default to self).
    if (nick && user) {
      throw new PlayerServiceError('Provide either a Discord user or a nick, not both.');
    }
    if (!nick && !user) {
      throw new PlayerServiceError('Provide a nick or a Discord user.');
    }

    const lookup = parseRankOptions({
      selfDiscordId: interaction.user.id,
      userDiscordId: user?.id,
      nick,
    });
    if (lookup.kind === 'both' || lookup.kind === 'self') {
      throw new PlayerServiceError('Provide a nick or a Discord user.');
    }

    const resolved = await resolveLeagueIdFromInteraction(
      interaction,
      getLeagueOption(interaction),
    );
    if (!resolved.ok) {
      await interaction.editReply({ content: resolved.message });
      return;
    }

    const gameProfile = await getGameProfileForLeague(resolved.leagueId);
    const player = await ensurePlayerForModLookup(gameProfile.gameId, lookup, {
      discordUsername: user ? (user.globalName ?? user.username) : null,
    });

    if (subcommand === 'set') {
      const result = await setPlayerNewFlag({
        leagueId: resolved.leagueId,
        playerId: player.id,
        username: player.username,
      });
      await interaction.editReply({
        content:
          result.status === 'set'
            ? `Marked **${result.username}** as New. They will not affect team ratings until 5 games.`
            : `**${result.username}** is already marked New.`,
      });
      return;
    }

    if (subcommand === 'clear') {
      const result = await clearPlayerNewFlag({
        leagueId: resolved.leagueId,
        playerId: player.id,
        username: player.username,
      });
      await interaction.editReply({
        content:
          result.status === 'cleared'
            ? `Cleared New from **${result.username}**. They rate normally from the next completed match.`
            : `**${result.username}** is not marked New.`,
      });
      return;
    }

    await interaction.editReply({ content: 'Unknown subcommand.' });
  } catch (error) {
    if (error instanceof PlayerServiceError || error instanceof MatchServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    log.error({ err: error }, 'player_new command failed');
    await interaction.editReply({ content: 'Something went wrong updating the New flag.' });
  }
}
