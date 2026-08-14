import { ChannelType, GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  assertCanConfigureBot,
  resolveGuildConfig,
  setMatchCreateRole,
  setMatchModRole,
  type RoleConfigSource,
} from '../../services/guild-config.js';
import {
  clearLiveLeaderboard,
  setupLiveLeaderboard,
} from '../../services/leaderboard-channel.js';
import { MatchServiceError } from '../../services/match-service.js';

const log = createLogger('config_cmd');

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

function formatRoleLine(
  label: string,
  roleId: string | undefined,
  source: RoleConfigSource,
): string {
  const value = roleId ? `<@&${roleId}> (\`${roleId}\`)` : '`unset`';
  return `**${label}:** ${value} — source: \`${source}\``;
}

function formatLeaderboardLine(
  channelId: string | undefined,
  messageId: string | undefined,
): string {
  if (!channelId || !messageId) {
    return '**Live leaderboard:** `unset`';
  }
  return `**Live leaderboard:** <#${channelId}> · message \`${messageId}\``;
}

export const data = new SlashCommandBuilder()
  .setName('config')
  .setDescription('View or set bot configuration for this server')
  .addSubcommand((subcommand) =>
    subcommand.setName('view').setDescription('Show match create/mod role settings'),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('set')
      .setDescription('Set a bot configuration value')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('create_role')
          .setDescription('Set the role required to register lobbies')
          .addRoleOption((option) =>
            option
              .setName('role')
              .setDescription('Discord role that may use /register_lobby')
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('mod_role')
          .setDescription('Set the role that may report/cancel matches like the host')
          .addRoleOption((option) =>
            option
              .setName('role')
              .setDescription('Discord role for match moderators')
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('leaderboard_channel')
          .setDescription('Set the channel for the live overall leaderboard message')
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel where the live leaderboard message is posted')
              .setRequired(true),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('clear')
      .setDescription('Clear a bot configuration value')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('leaderboard_channel')
          .setDescription('Remove the live overall leaderboard message binding'),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
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
      await interaction.reply({
        content: error.message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }

  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(true);

  if (subcommand === 'view') {
    const resolved = await resolveGuildConfig(interaction.guildId);
    await interaction.reply({
      content: [
        'Bot configuration for this server:',
        formatRoleLine(
          'Create role',
          resolved.matchCreateRoleId,
          resolved.matchCreateRoleSource,
        ),
        formatRoleLine('Mod role', resolved.matchModRoleId, resolved.matchModRoleSource),
        formatLeaderboardLine(
          resolved.leaderboardChannelId,
          resolved.leaderboardMessageId,
        ),
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommandGroup === 'set') {
    if (subcommand === 'create_role') {
      const role = interaction.options.getRole('role', true);
      await setMatchCreateRole(interaction.guildId, role.id);
      log.info(
        { guildId: interaction.guildId, roleId: role.id, userId: interaction.user.id },
        'Match create role updated',
      );
      await interaction.reply({
        content: `Create role set to <@&${role.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'mod_role') {
      const role = interaction.options.getRole('role', true);
      await setMatchModRole(interaction.guildId, role.id);
      log.info(
        { guildId: interaction.guildId, roleId: role.id, userId: interaction.user.id },
        'Match mod role updated',
      );
      await interaction.reply({
        content: `Mod role set to <@&${role.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'leaderboard_channel') {
      const channel = interaction.options.getChannel('channel', true);
      const allowedTypes = new Set([
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.GuildForum,
      ]);
      if (!allowedTypes.has(channel.type)) {
        await interaction.reply({
          content: 'Choose a server text channel for the live leaderboard.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await setupLiveLeaderboard(interaction.client, interaction.guildId, channel.id);
      log.info(
        { guildId: interaction.guildId, channelId: channel.id, userId: interaction.user.id },
        'Live leaderboard channel updated',
      );
      await interaction.reply({
        content: `Live overall leaderboard set in <#${channel.id}>. Keep only that message there.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  if (subcommandGroup === 'clear') {
    if (subcommand === 'leaderboard_channel') {
      await clearLiveLeaderboard(interaction.client, interaction.guildId);
      log.info(
        { guildId: interaction.guildId, userId: interaction.user.id },
        'Live leaderboard channel cleared',
      );
      await interaction.reply({
        content: 'Live overall leaderboard cleared.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  await interaction.reply({
    content: 'Unknown config subcommand.',
    flags: MessageFlags.Ephemeral,
  });
}
