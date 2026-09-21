import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { resolveGuildConfig } from '../../services/guild/index.js';
import {
  getGameProfileForLeague,
  getLeagueOption,
  resolveLeagueIdFromInteraction,
  respondLeagueAutocomplete,
  withOptionalLeagueOption,
} from '../../services/league/index.js';
import { assertHasMatchModRole, hasMatchModRole } from '../../services/match/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import { linkPlayer } from '../../services/player/index.js';
import { PlayerServiceError } from '../../services/player/index.js';

const log = createLogger('link_cmd');

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

export const data = withOptionalLeagueOption(
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link an in-game nick to a Discord account')
    .addStringOption((option) =>
      option.setName('nick').setDescription('In-game nick').setRequired(true),
    )
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Discord user to bind (default: you; others require a moderator)')
        .setRequired(false),
    ),
);

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondLeagueAutocomplete(interaction);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const nick = interaction.options.getString('nick', true);
  const target = interaction.options.getUser('user') ?? interaction.user;
  const linkingOther = target.id !== interaction.user.id;

  try {
    if (!interaction.guildId) {
      await interaction.editReply({ content: 'This command can only be used in a server.' });
      return;
    }

    const config = await resolveGuildConfig(interaction.guildId);
    const roleInput = {
      actorDiscordId: interaction.user.id,
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: config.matchModRoleId,
    };
    const isMod = hasMatchModRole(roleInput);

    if (linkingOther) {
      assertHasMatchModRole(roleInput);
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
    const linked = await linkPlayer({
      gameId: gameProfile.gameId,
      nick,
      discordId: target.id,
      allowRelink: isMod,
    });
    await interaction.editReply({
      content: `Linked **${linked.username}** to <@${linked.discordId}> for \`${linked.gameId}\`.`,
    });
  } catch (error) {
    if (error instanceof PlayerServiceError || error instanceof MatchServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    log.error({ err: error }, 'link command failed');
    await interaction.editReply({ content: 'Something went wrong linking that account.' });
  }
}
