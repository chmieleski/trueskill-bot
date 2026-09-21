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
import { assertHasMatchModRole } from '../../services/match/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import { unlinkByDiscordId } from '../../services/player/index.js';
import { PlayerServiceError } from '../../services/player/index.js';

const log = createLogger('unlink_cmd');

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
    .setName('unlink')
    .setDescription('Unlink a Discord account from an in-game nick')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Discord user to unlink (moderators only)')
        .setRequired(false),
    ),
);

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondLeagueAutocomplete(interaction);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user');
  const self = !target || target.id === interaction.user.id;
  const discordId = self ? interaction.user.id : target!.id;

  try {
    if (!interaction.guildId) {
      await interaction.editReply({ content: 'This command can only be used in a server.' });
      return;
    }

    if (!self) {
      const config = await resolveGuildConfig(interaction.guildId);
      assertHasMatchModRole({
        actorDiscordId: interaction.user.id,
        memberRoleIds: memberRoleIds(interaction),
        matchModRoleId: config.matchModRoleId,
      });
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
    const result = await unlinkByDiscordId(gameProfile.gameId, discordId, { self });
    await interaction.editReply({
      content: self
        ? `Unlinked your Discord from **${result.username}** for \`${gameProfile.gameId}\`.`
        : `Unlinked <@${discordId}> from **${result.username}** for \`${gameProfile.gameId}\`.`,
    });
  } catch (error) {
    if (error instanceof PlayerServiceError || error instanceof MatchServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    log.error({ err: error }, 'unlink command failed');
    await interaction.editReply({ content: 'Something went wrong unlinking that account.' });
  }
}
