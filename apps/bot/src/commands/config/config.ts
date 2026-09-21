import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  clearQuitterLeaderboardDisplay,
  clearQuitterLeaderboardSize,
  clearQuitterLeaderboardSort,
  clearGrieferLeaderboardDisplay,
  clearGrieferLeaderboardSize,
  clearGrieferLeaderboardSort,
  clearCompletedMatchLogChannel,
  setMatchCreateRole,
  setMatchModRole,
  setQuitterLeaderboardDisplay,
  setQuitterLeaderboardSize,
  setQuitterLeaderboardSort,
  setGrieferLeaderboardDisplay,
  setGrieferLeaderboardSize,
  setGrieferLeaderboardSort,
  setCompletedMatchLogChannel,
  setOpsAlertChannel,
  clearOpsAlertChannel,
  type GrieferLeaderboardDisplayValue,
  type GrieferLeaderboardSortValue,
  type QuitterLeaderboardDisplayValue,
  type QuitterLeaderboardSortValue,
} from '../../services/guild/index.js';
import {
  respondLeagueAutocomplete,
  withSubcommandLeagueOption,
} from '../../services/league/index.js';
import {
  assertGrieferLeaderboardSize,
  assertQuitterLeaderboardSize,
  clearGrieferLiveLeaderboard,
  clearQuitterLiveLeaderboard,
  LeaderboardServiceError,
  refreshGuildGrieferLeaderboard,
  refreshGuildQuitterLeaderboard,
  setupGrieferLiveLeaderboard,
  setupQuitterLiveLeaderboard,
} from '../../services/leaderboard/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import {
  clearChangelogChannel,
  clearChangelogDraftChannel,
  postPendingStaffCards,
  ReleaseServiceError,
  setChangelogChannel,
  setChangelogDraftChannel,
} from '../../services/release/index.js';
import {
  assertConfigStaff,
  assertCanSetMatchLogChannel,
  buildConfigViewContent,
} from './config-shared.js';

const log = createLogger('config_cmd');

export const data = new SlashCommandBuilder()
  .setName('config')
  .setDescription('View or set guild-wide bot configuration')
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand.setName('view').setDescription('Show bot settings for this server'),
    ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('set')
      .setDescription('Set a guild configuration value')
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
          .setName('quitter_leaderboard_channel')
          .setDescription('Set the channel for the live quitter leaderboard message')
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel where the live quitter leaderboard message is posted')
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('quitter_leaderboard_size')
          .setDescription('How many players appear on the live quitter leaderboard')
          .addIntegerOption((option) =>
            option
              .setName('size')
              .setDescription('Number of ranks to show (10–100)')
              .setRequired(true)
              .setMinValue(10)
              .setMaxValue(100),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('quitter_leaderboard_display')
          .setDescription('Columns shown on the quitter leaderboard')
          .addStringOption((option) =>
            option
              .setName('display')
              .setDescription('Show quit count, quit rate, or both')
              .setRequired(true)
              .addChoices(
                { name: 'count', value: 'count' },
                { name: 'rate', value: 'rate' },
                { name: 'both', value: 'both' },
              ),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('quitter_leaderboard_sort')
          .setDescription('Sort order for the quitter leaderboard')
          .addStringOption((option) =>
            option
              .setName('sort')
              .setDescription('Rank by quit count or quit rate')
              .setRequired(true)
              .addChoices({ name: 'count', value: 'count' }, { name: 'rate', value: 'rate' }),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('griefer_leaderboard_channel')
          .setDescription('Set the channel for the live griefer leaderboard message')
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel where the live griefer leaderboard message is posted')
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('griefer_leaderboard_size')
          .setDescription('How many players appear on the live griefer leaderboard')
          .addIntegerOption((option) =>
            option
              .setName('size')
              .setDescription('Number of ranks to show (10–100)')
              .setRequired(true)
              .setMinValue(10)
              .setMaxValue(100),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('griefer_leaderboard_display')
          .setDescription('Columns shown on the griefer leaderboard')
          .addStringOption((option) =>
            option
              .setName('display')
              .setDescription('Show grief count, grief rate, or both (includes pending tax)')
              .setRequired(true)
              .addChoices(
                { name: 'count', value: 'count' },
                { name: 'rate', value: 'rate' },
                { name: 'both', value: 'both' },
              ),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('griefer_leaderboard_sort')
          .setDescription('Sort order for the griefer leaderboard')
          .addStringOption((option) =>
            option
              .setName('sort')
              .setDescription('Rank by grief count or grief rate')
              .setRequired(true)
              .addChoices({ name: 'count', value: 'count' }, { name: 'rate', value: 'rate' }),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('changelog_channel')
          .setDescription('Set the channel for player changelog posts')
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel where player changelogs are posted')
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('changelog_draft_channel')
          .setDescription('Set the staff channel for changelog drafts')
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel where staff changelog drafts are posted')
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('completed_match_log_channel')
          .setDescription('Set the channel that receives a copy of each completed match')
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel where completed matches are logged')
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('ops_channel')
          .setDescription('Set the channel for bot process ops alerts')
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel where lifecycle and health alerts are posted')
              .setRequired(true),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('clear')
      .setDescription('Clear a guild configuration value')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('quitter_leaderboard_channel')
          .setDescription('Remove the live quitter leaderboard message binding'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('quitter_leaderboard_size')
          .setDescription('Reset quitter leaderboard size to 10'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('quitter_leaderboard_display')
          .setDescription('Reset quitter leaderboard display to both'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('quitter_leaderboard_sort')
          .setDescription('Reset quitter leaderboard sort to count'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('griefer_leaderboard_channel')
          .setDescription('Remove the live griefer leaderboard message binding'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('griefer_leaderboard_size')
          .setDescription('Reset griefer leaderboard size to 10'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('griefer_leaderboard_display')
          .setDescription('Reset griefer leaderboard display to both'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('griefer_leaderboard_sort')
          .setDescription('Reset griefer leaderboard sort to count'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('changelog_channel')
          .setDescription('Remove the player changelog channel'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('changelog_draft_channel')
          .setDescription('Remove the staff changelog draft channel'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('completed_match_log_channel')
          .setDescription('Remove the completed match log channel'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('ops_channel')
          .setDescription('Remove the bot process ops alert channel'),
      ),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondLeagueAutocomplete(interaction);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: 'This command can only be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(true);
  const isMatchLogConfig =
    (subcommandGroup === 'set' || subcommandGroup === 'clear') &&
    subcommand === 'completed_match_log_channel';

  try {
    if (isMatchLogConfig) {
      await assertCanSetMatchLogChannel(interaction);
    } else {
      assertConfigStaff(interaction);
    }
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

  try {
    if (subcommand === 'view') {
      const content = await buildConfigViewContent(interaction, interaction.guildId);
      await interaction.reply({
        content: content ?? 'Could not load configuration.',
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

      if (subcommand === 'quitter_leaderboard_channel') {
        const channel = interaction.options.getChannel('channel', true);
        const allowedTypes = new Set([
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.GuildForum,
        ]);
        if (!allowedTypes.has(channel.type)) {
          await interaction.reply({
            content: 'Choose a server text channel for the quitter leaderboard.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await setupQuitterLiveLeaderboard(interaction.client, interaction.guildId, channel.id);
        log.info(
          {
            guildId: interaction.guildId,
            channelId: channel.id,
            userId: interaction.user.id,
          },
          'Quitter leaderboard channel updated',
        );
        await interaction.reply({
          content: `Live quitter leaderboard set in <#${channel.id}>. Keep only that message there.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'quitter_leaderboard_size') {
        const size = interaction.options.getInteger('size', true);
        try {
          assertQuitterLeaderboardSize(size);
          await setQuitterLeaderboardSize(interaction.guildId, size);
        } catch (error) {
          if (error instanceof LeaderboardServiceError) {
            await interaction.reply({
              content: error.message,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          throw error;
        }

        await refreshGuildQuitterLeaderboard(interaction.client, interaction.guildId);
        log.info(
          { guildId: interaction.guildId, size, userId: interaction.user.id },
          'Quitter leaderboard size updated',
        );
        await interaction.reply({
          content: `Quitter leaderboard size set to \`${size}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'quitter_leaderboard_display') {
        const display = interaction.options.getString(
          'display',
          true,
        ) as QuitterLeaderboardDisplayValue;
        await setQuitterLeaderboardDisplay(interaction.guildId, display);
        await refreshGuildQuitterLeaderboard(interaction.client, interaction.guildId);
        log.info(
          { guildId: interaction.guildId, display, userId: interaction.user.id },
          'Quitter leaderboard display updated',
        );
        await interaction.reply({
          content: `Quitter leaderboard display set to \`${display}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'quitter_leaderboard_sort') {
        const sort = interaction.options.getString('sort', true) as QuitterLeaderboardSortValue;
        await setQuitterLeaderboardSort(interaction.guildId, sort);
        await refreshGuildQuitterLeaderboard(interaction.client, interaction.guildId);
        log.info(
          { guildId: interaction.guildId, sort, userId: interaction.user.id },
          'Quitter leaderboard sort updated',
        );
        await interaction.reply({
          content: `Quitter leaderboard sort set to \`${sort}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'griefer_leaderboard_channel') {
        const channel = interaction.options.getChannel('channel', true);
        const allowedTypes = new Set([
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.GuildForum,
        ]);
        if (!allowedTypes.has(channel.type)) {
          await interaction.reply({
            content: 'Choose a server text channel for the griefer leaderboard.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await setupGrieferLiveLeaderboard(interaction.client, interaction.guildId, channel.id);
        log.info(
          {
            guildId: interaction.guildId,
            channelId: channel.id,
            userId: interaction.user.id,
          },
          'Griefer leaderboard channel updated',
        );
        await interaction.reply({
          content: `Live griefer leaderboard set in <#${channel.id}>. Keep only that message there.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'griefer_leaderboard_size') {
        const size = interaction.options.getInteger('size', true);
        try {
          assertGrieferLeaderboardSize(size);
          await setGrieferLeaderboardSize(interaction.guildId, size);
        } catch (error) {
          if (error instanceof LeaderboardServiceError) {
            await interaction.reply({
              content: error.message,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          throw error;
        }

        await refreshGuildGrieferLeaderboard(interaction.client, interaction.guildId);
        log.info(
          { guildId: interaction.guildId, size, userId: interaction.user.id },
          'Griefer leaderboard size updated',
        );
        await interaction.reply({
          content: `Griefer leaderboard size set to \`${size}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'griefer_leaderboard_display') {
        const display = interaction.options.getString(
          'display',
          true,
        ) as GrieferLeaderboardDisplayValue;
        await setGrieferLeaderboardDisplay(interaction.guildId, display);
        await refreshGuildGrieferLeaderboard(interaction.client, interaction.guildId);
        log.info(
          { guildId: interaction.guildId, display, userId: interaction.user.id },
          'Griefer leaderboard display updated',
        );
        await interaction.reply({
          content: `Griefer leaderboard display set to \`${display}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'griefer_leaderboard_sort') {
        const sort = interaction.options.getString('sort', true) as GrieferLeaderboardSortValue;
        await setGrieferLeaderboardSort(interaction.guildId, sort);
        await refreshGuildGrieferLeaderboard(interaction.client, interaction.guildId);
        log.info(
          { guildId: interaction.guildId, sort, userId: interaction.user.id },
          'Griefer leaderboard sort updated',
        );
        await interaction.reply({
          content: `Griefer leaderboard sort set to \`${sort}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'changelog_channel') {
        const channel = interaction.options.getChannel('channel', true);
        const allowedTypes = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
        if (!allowedTypes.has(channel.type)) {
          await interaction.reply({
            content: 'Choose a server text or announcement channel for changelogs.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await setChangelogChannel(interaction.guildId, channel.id);
        log.info(
          {
            guildId: interaction.guildId,
            channelId: channel.id,
            userId: interaction.user.id,
          },
          'Changelog channel updated',
        );
        await interaction.reply({
          content: `Changelog channel set to <#${channel.id}>.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'changelog_draft_channel') {
        const channel = interaction.options.getChannel('channel', true);
        const allowedTypes = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
        if (!allowedTypes.has(channel.type)) {
          await interaction.reply({
            content: 'Choose a server text or announcement channel for changelog drafts.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await setChangelogDraftChannel(interaction.guildId, channel.id);
        log.info(
          {
            guildId: interaction.guildId,
            channelId: channel.id,
            userId: interaction.user.id,
          },
          'Changelog draft channel updated',
        );
        await interaction.reply({
          content: `Changelog draft channel set to <#${channel.id}>. Pending drafts will post there.`,
          flags: MessageFlags.Ephemeral,
        });
        await postPendingStaffCards(interaction.client);
        return;
      }

      if (subcommand === 'completed_match_log_channel') {
        const channel = interaction.options.getChannel('channel', true);
        const allowedTypes = new Set([
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.GuildForum,
        ]);
        if (!allowedTypes.has(channel.type)) {
          await interaction.reply({
            content: 'Choose a server text channel for the completed match log.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await setCompletedMatchLogChannel(interaction.guildId, channel.id);
        log.info(
          {
            guildId: interaction.guildId,
            channelId: channel.id,
            userId: interaction.user.id,
          },
          'Completed match log channel updated',
        );
        await interaction.reply({
          content: `Completed match log channel set to <#${channel.id}>. New completions will also post there.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'ops_channel') {
        const channel = interaction.options.getChannel('channel', true);
        const allowedTypes = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
        if (!allowedTypes.has(channel.type)) {
          await interaction.reply({
            content: 'Choose a server text or announcement channel for ops alerts.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await setOpsAlertChannel(interaction.guildId, channel.id);
        log.info(
          {
            guildId: interaction.guildId,
            channelId: channel.id,
            userId: interaction.user.id,
          },
          'Ops alert channel updated',
        );
        await interaction.reply({
          content: `Ops alert channel set to <#${channel.id}>.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    if (subcommandGroup === 'clear') {
      if (subcommand === 'quitter_leaderboard_channel') {
        await clearQuitterLiveLeaderboard(interaction.client, interaction.guildId);
        log.info(
          { guildId: interaction.guildId, userId: interaction.user.id },
          'Quitter leaderboard channel cleared',
        );
        await interaction.reply({
          content: 'Live quitter leaderboard cleared.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'quitter_leaderboard_size') {
        await clearQuitterLeaderboardSize(interaction.guildId);
        await refreshGuildQuitterLeaderboard(interaction.client, interaction.guildId);
        log.info(
          { guildId: interaction.guildId, userId: interaction.user.id },
          'Quitter leaderboard size cleared',
        );
        await interaction.reply({
          content: 'Quitter leaderboard size reset to `10`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'quitter_leaderboard_display') {
        await clearQuitterLeaderboardDisplay(interaction.guildId);
        await refreshGuildQuitterLeaderboard(interaction.client, interaction.guildId);
        log.info(
          { guildId: interaction.guildId, userId: interaction.user.id },
          'Quitter leaderboard display cleared',
        );
        await interaction.reply({
          content: 'Quitter leaderboard display reset to `both`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'quitter_leaderboard_sort') {
        await clearQuitterLeaderboardSort(interaction.guildId);
        await refreshGuildQuitterLeaderboard(interaction.client, interaction.guildId);
        log.info(
          { guildId: interaction.guildId, userId: interaction.user.id },
          'Quitter leaderboard sort cleared',
        );
        await interaction.reply({
          content: 'Quitter leaderboard sort reset to `count`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'griefer_leaderboard_channel') {
        await clearGrieferLiveLeaderboard(interaction.client, interaction.guildId);
        log.info(
          { guildId: interaction.guildId, userId: interaction.user.id },
          'Griefer leaderboard channel cleared',
        );
        await interaction.reply({
          content: 'Live griefer leaderboard cleared.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'griefer_leaderboard_size') {
        await clearGrieferLeaderboardSize(interaction.guildId);
        await refreshGuildGrieferLeaderboard(interaction.client, interaction.guildId);
        log.info(
          { guildId: interaction.guildId, userId: interaction.user.id },
          'Griefer leaderboard size cleared',
        );
        await interaction.reply({
          content: 'Griefer leaderboard size reset to `10`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'griefer_leaderboard_display') {
        await clearGrieferLeaderboardDisplay(interaction.guildId);
        await refreshGuildGrieferLeaderboard(interaction.client, interaction.guildId);
        log.info(
          { guildId: interaction.guildId, userId: interaction.user.id },
          'Griefer leaderboard display cleared',
        );
        await interaction.reply({
          content: 'Griefer leaderboard display reset to `both`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'griefer_leaderboard_sort') {
        await clearGrieferLeaderboardSort(interaction.guildId);
        await refreshGuildGrieferLeaderboard(interaction.client, interaction.guildId);
        log.info(
          { guildId: interaction.guildId, userId: interaction.user.id },
          'Griefer leaderboard sort cleared',
        );
        await interaction.reply({
          content: 'Griefer leaderboard sort reset to `count`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'changelog_channel') {
        await clearChangelogChannel(interaction.guildId);
        log.info(
          { guildId: interaction.guildId, userId: interaction.user.id },
          'Changelog channel cleared',
        );
        await interaction.reply({
          content: 'Changelog channel cleared.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'changelog_draft_channel') {
        await clearChangelogDraftChannel(interaction.guildId);
        log.info(
          { guildId: interaction.guildId, userId: interaction.user.id },
          'Changelog draft channel cleared',
        );
        await interaction.reply({
          content: 'Changelog draft channel cleared.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'completed_match_log_channel') {
        await clearCompletedMatchLogChannel(interaction.guildId);
        log.info(
          { guildId: interaction.guildId, userId: interaction.user.id },
          'Completed match log channel cleared',
        );
        await interaction.reply({
          content: 'Completed match log channel cleared.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'ops_channel') {
        await clearOpsAlertChannel(interaction.guildId);
        log.info(
          { guildId: interaction.guildId, userId: interaction.user.id },
          'Ops alert channel cleared',
        );
        await interaction.reply({
          content: 'Ops alert channel cleared.',
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
    if (error instanceof MatchServiceError || error instanceof ReleaseServiceError) {
      await interaction.reply({
        content: error.message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }
}
