import { ChannelType, GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  applyUdbrWc3statsPreset,
  assertCanConfigureBot,
  clearGuildWc3statsPackage,
  resolveGuildConfig,
  setLobbyPlayerClaimEnabled,
  setMatchCreateRole,
  setMatchModRole,
  type RoleConfigSource,
} from '../../services/guild/index.js';
import {
  clearAllGuildWc3statsSlotMaps,
  clearGuildWc3statsSlotMap,
  formatWc3statsSlotMapLines,
  listGuildWc3statsSlotMaps,
  parseWc3statsSlotMapEntries,
  replaceGuildWc3statsSlotMaps,
  setGuildWc3statsSlotMap,
} from '../../services/wc3stats/index.js';
import {
  clearLiveLeaderboard,
  setupLiveLeaderboard,
} from '../../services/leaderboard/index.js';
import { MatchServiceError } from '../../services/match/index.js';

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

function formatPlayerClaimLine(enabled: boolean): string {
  return `**Player claim:** \`${enabled ? 'on' : 'off'}\``;
}

function formatWc3statsEnabledLine(enabled: boolean): string {
  return `**wc3stats import:** \`${enabled ? 'on' : 'off'}\``;
}

function formatWc3statsFilterLines(
  pattern: string | undefined,
  sha1: string[],
): string[] {
  return [
    `**wc3stats map pattern:** ${pattern ? `\`${pattern}\`` : '`unset`'}`,
    `**wc3stats map sha1:** ${
      sha1.length > 0 ? sha1.map((s) => `\`${s}\``).join(', ') : '`unset`'
    }`,
  ];
}

function formatWc3statsMapSection(lines: string[]): string {
  return ['**wc3stats → hero slots:**', ...lines.map((line) => `• ${line}`)].join('\n');
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
    subcommand.setName('view').setDescription('Show bot settings for this server'),
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
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('player_claim')
          .setDescription('Allow linked players to claim a lobby slot')
          .addBooleanOption((option) =>
            option
              .setName('enabled')
              .setDescription('On: players can claim/leave slots. Off: host seats only.')
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('wc3stats_slot')
          .setDescription('Map one wc3stats slot index to a hero/lobby slot')
          .addIntegerOption((option) =>
            option
              .setName('wc3_slot')
              .setDescription('0-based index in wc3stats slots[] (classic color order)')
              .setRequired(true)
              .setMinValue(0)
              .setMaxValue(23),
          )
          .addIntegerOption((option) =>
            option
              .setName('hero_slot')
              .setDescription('Bot hero/lobby slot (1-12)')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(12),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('wc3stats_map')
          .setDescription('Replace all wc3stats→hero mappings (bulk)')
          .addStringOption((option) =>
            option
              .setName('entries')
              .setDescription('Pairs like 0=1,1=2,4=7 (wc3_slot=hero_slot)')
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('wc3stats_map_preset')
          .setDescription('Load a built-in wc3stats→hero map for this server')
          .addStringOption((option) =>
            option
              .setName('preset')
              .setDescription('Built-in layout')
              .setRequired(true)
              .addChoices({ name: 'UDBR (Z Fighters / Evils)', value: 'udbr' }),
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
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('wc3stats_slot')
          .setDescription('Remove one wc3stats→hero mapping')
          .addIntegerOption((option) =>
            option
              .setName('wc3_slot')
              .setDescription('0-based wc3stats slots[] index to unmap')
              .setRequired(true)
              .setMinValue(0)
              .setMaxValue(23),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('wc3stats_map')
          .setDescription('Remove all wc3stats→hero mappings for this server'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('wc3stats')
          .setDescription('Disable wc3stats import and clear filter + slot map for this server'),
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

  try {
    if (subcommand === 'view') {
      const resolved = await resolveGuildConfig(interaction.guildId);
      const slotMaps = await listGuildWc3statsSlotMaps(interaction.guildId);
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
          formatPlayerClaimLine(resolved.lobbyPlayerClaimEnabled),
          formatWc3statsEnabledLine(resolved.wc3statsEnabled),
          ...formatWc3statsFilterLines(
            resolved.wc3statsMapPattern,
            resolved.wc3statsMapSha1,
          ),
          formatWc3statsMapSection(formatWc3statsSlotMapLines(slotMaps)),
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

      if (subcommand === 'player_claim') {
        const enabled = interaction.options.getBoolean('enabled', true);
        await setLobbyPlayerClaimEnabled(interaction.guildId, enabled);
        log.info(
          { guildId: interaction.guildId, enabled, userId: interaction.user.id },
          'Lobby player claim setting updated',
        );
        await interaction.reply({
          content: enabled
            ? 'Player slot claim enabled.'
            : 'Player slot claim disabled. Hosts can still add players by nick or Discord user.',
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
          {
            guildId: interaction.guildId,
            channelId: channel.id,
            userId: interaction.user.id,
          },
          'Live leaderboard channel updated',
        );
        await interaction.reply({
          content: `Live overall leaderboard set in <#${channel.id}>. Keep only that message there.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'wc3stats_slot') {
        const wc3Slot = interaction.options.getInteger('wc3_slot', true);
        const heroSlot = interaction.options.getInteger('hero_slot', true);
        await setGuildWc3statsSlotMap(interaction.guildId, wc3Slot, heroSlot);
        log.info(
          {
            guildId: interaction.guildId,
            wc3Slot,
            heroSlot,
            userId: interaction.user.id,
          },
          'wc3stats slot map entry updated',
        );
        await interaction.reply({
          content: `Mapped wc3stats slot \`${wc3Slot}\` → hero slot \`${heroSlot}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'wc3stats_map') {
        const entries = parseWc3statsSlotMapEntries(
          interaction.options.getString('entries', true),
        );
        await replaceGuildWc3statsSlotMaps(interaction.guildId, entries);
        log.info(
          {
            guildId: interaction.guildId,
            count: entries.length,
            userId: interaction.user.id,
          },
          'wc3stats slot map replaced',
        );
        await interaction.reply({
          content: [
            `Replaced wc3stats→hero map (${entries.length} entries):`,
            ...formatWc3statsSlotMapLines(entries).map((line) => `• ${line}`),
          ].join('\n'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'wc3stats_map_preset') {
        const preset = interaction.options.getString('preset', true);
        if (preset !== 'udbr') {
          await interaction.reply({
            content: 'Unknown preset.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await applyUdbrWc3statsPreset(interaction.guildId);
        log.info(
          { guildId: interaction.guildId, preset, userId: interaction.user.id },
          'wc3stats package preset applied',
        );
        await interaction.reply({
          content: 'Applied UDBR preset: import enabled, map filter set, slot layout applied.',
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

      if (subcommand === 'wc3stats_slot') {
        const wc3Slot = interaction.options.getInteger('wc3_slot', true);
        const removed = await clearGuildWc3statsSlotMap(interaction.guildId, wc3Slot);
        log.info(
          {
            guildId: interaction.guildId,
            wc3Slot,
            removed,
            userId: interaction.user.id,
          },
          'wc3stats slot map entry cleared',
        );
        await interaction.reply({
          content: removed
            ? `Cleared mapping for wc3stats slot \`${wc3Slot}\`.`
            : `No mapping found for wc3stats slot \`${wc3Slot}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'wc3stats') {
        await clearGuildWc3statsPackage(interaction.guildId);
        await interaction.reply({
          content:
            'wc3stats import disabled. Map filter and slot mappings cleared for this server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'wc3stats_map') {
        const removed = await clearAllGuildWc3statsSlotMaps(interaction.guildId);
        log.info(
          { guildId: interaction.guildId, removed, userId: interaction.user.id },
          'wc3stats slot map cleared',
        );
        await interaction.reply({
          content:
            removed > 0
              ? `Cleared ${removed} wc3stats→hero mapping(s). Imports will use legacy index+1 until remapped.`
              : 'No wc3stats→hero mappings to clear.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    await interaction.reply({
      content: 'Unknown config subcommand.',
      flags: MessageFlags.Ephemeral,
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
}
