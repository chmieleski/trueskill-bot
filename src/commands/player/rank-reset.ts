import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { buildRankResetConfirmComponents } from '../../discord/interactions/rank-reset-interactions.js';
import { createLogger } from '../../lib/logger.js';
import { resolveGuildConfig } from '../../services/guild/index.js';
import {
  getLeagueOption,
  resolveLeagueIdFromInteraction,
  respondLeagueAutocomplete,
  withOptionalLeagueOption,
} from '../../services/league/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import { previewRankReset, RankResetServiceError } from '../../services/rating/index.js';

const log = createLogger('rank_reset_cmd');

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

function buildRankResetWarning(preview: {
  username: string;
  staffOverride: boolean;
  cooldownDays: number;
}): string {
  const cooldownLine = `After confirming, the next self-reset will be blocked for **${preview.cooldownDays}** day${
    preview.cooldownDays === 1 ? '' : 's'
  }.`;

  if (preview.staffOverride) {
    return [
      `This will wipe **${preview.username}**'s overall rating and all hero ki for this league.`,
      'This cannot be undone.',
      cooldownLine,
    ].join('\n');
  }

  return [
    'This will wipe your overall rating and all hero ki for this league.',
    'This cannot be undone.',
    cooldownLine,
  ].join('\n');
}

export const data = withOptionalLeagueOption(
  new SlashCommandBuilder()
    .setName('rank_reset')
    .setDescription('Reset overall and hero ki for this league when rank reset is enabled')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Discord user to reset (moderators only)')
        .setRequired(false),
    ),
);

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondLeagueAutocomplete(interaction);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (!interaction.guildId) {
      await interaction.editReply({ content: 'This command can only be used in a server.' });
      return;
    }

    const resolved = await resolveLeagueIdFromInteraction(
      interaction,
      getLeagueOption(interaction),
    );
    if (!resolved.ok) {
      await interaction.editReply({ content: resolved.message });
      return;
    }

    const target = interaction.options.getUser('user') ?? interaction.user;
    const config = await resolveGuildConfig(interaction.guildId);
    const preview = await previewRankReset({
      leagueId: resolved.leagueId,
      actorDiscordId: interaction.user.id,
      targetDiscordId: target.id,
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: config.matchModRoleId,
    });

    await interaction.editReply({
      content: buildRankResetWarning(preview),
      components: buildRankResetConfirmComponents({
        leagueId: preview.leagueId,
        playerId: preview.playerId,
        actorDiscordId: interaction.user.id,
      }),
    });
  } catch (error) {
    if (error instanceof RankResetServiceError || error instanceof MatchServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    log.error({ err: error }, 'rank_reset command failed');
    await interaction.editReply({ content: 'Something went wrong preparing that rank reset.' });
  }
}
