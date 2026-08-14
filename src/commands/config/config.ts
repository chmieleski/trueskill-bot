import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  assertCanConfigureBot,
  resolveGuildConfig,
  setMatchCreateRole,
  setMatchModRole,
  type RoleConfigSource,
} from '../../services/guild-config.js';
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
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommandGroup === 'set') {
    const role = interaction.options.getRole('role', true);

    if (subcommand === 'create_role') {
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
  }

  await interaction.reply({
    content: 'Unknown config subcommand.',
    flags: MessageFlags.Ephemeral,
  });
}
