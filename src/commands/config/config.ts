import { ChannelType, GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  assertCanConfigureBot,
  resolveGuildConfig,
  setMatchCreateRole,
  setMatchModRole,
  type RoleConfigSource,
} from '../../services/guild/index.js';
import {
  applyUdbrWc3statsPreset,
  assertLeagueAllowsWc3stats,
  clearLeagueLeaderboardSize,
  clearLeagueWc3statsHostPrompt,
  clearLeagueWc3statsPackage,
  resolveLeagueConfig,
  setLeagueLeaderboardSize,
  setLeagueLobbyPlayerClaimEnabled,
  setLeagueRankResetCooldownDays,
  setLeagueRankResetEnabled,
  setLeagueWc3statsHostPrompt,
} from '../../services/league/league-wc3stats.js';
import {
  getLeagueOption,
  leagueResolveFailureMessage,
  resolveLeagueFromInteraction,
  resolveLeagueIdFromInteraction,
  respondLeagueAutocomplete,
  withSubcommandLeagueOption,
} from '../../services/league/index.js';
import {
  clearAllLeagueWc3statsSlotMaps,
  clearLeagueWc3statsSlotMap,
  formatWc3statsSlotMapLines,
  listLeagueWc3statsSlotMaps,
  parseWc3statsSlotMapEntries,
  replaceLeagueWc3statsSlotMaps,
  setLeagueWc3statsSlotMap,
} from '../../services/wc3stats/index.js';
import {
  clearLiveLeaderboard,
  LeaderboardServiceError,
  refreshLeagueLeaderboard,
  setupLiveLeaderboard,
} from '../../services/leaderboard/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import { RankResetServiceError } from '../../services/rating/index.js';

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

function formatRankResetLine(enabled: boolean, cooldownDays: number): string {
  return `**Rank reset:** \`${enabled ? 'on' : 'off'}\` · cooldown \`${cooldownDays}d\``;
}

function formatWc3statsHostPromptLine(
  enabled: boolean,
  channelId: string | undefined,
): string {
  if (!enabled || !channelId) {
    return '**wc3stats host lobby prompt:** `off`';
  }
  return `**wc3stats host lobby prompt:** \`on\` · <#${channelId}>`;
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
  size: number,
): string {
  if (!channelId || !messageId) {
    return `**Live leaderboard:** \`unset\` · size \`${size}\``;
  }
  return `**Live leaderboard:** <#${channelId}> · message \`${messageId}\` · size \`${size}\``;
}

function formatLeagueLine(name: string | undefined): string {
  return `**League:** ${name ? `\`${name}\`` : '`unset`'}`;
}

export const data = new SlashCommandBuilder()
  .setName('config')
  .setDescription('View or set bot configuration for this server')
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand.setName('view').setDescription('Show bot settings for this server'),
    ),
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
        withSubcommandLeagueOption(
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
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('leaderboard_size')
            .setDescription('How many players appear on the live overall leaderboard')
            .addIntegerOption((option) =>
              option
                .setName('size')
                .setDescription('Number of ranks to show (10–100)')
                .setRequired(true)
                .setMinValue(10)
                .setMaxValue(100),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('player_claim')
            .setDescription('Allow linked players to claim a lobby slot')
            .addBooleanOption((option) =>
              option
                .setName('enabled')
                .setDescription('On: players can claim/leave slots. Off: host seats only.')
                .setRequired(true),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('rank_reset')
            .setDescription('Enable or disable player rank reset for this league')
            .addBooleanOption((option) =>
              option
                .setName('enabled')
                .setDescription('On: linked players may use /rank_reset. Off: command rejected.')
                .setRequired(true),
            )
            .addIntegerOption((option) =>
              option
                .setName('cooldown_days')
                .setDescription('Days between self-resets (1–365); optional when toggling')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(365),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('rank_reset_cooldown')
            .setDescription('Set the cooldown between player self rank resets')
            .addIntegerOption((option) =>
              option
                .setName('days')
                .setDescription('Days between self-resets (1–365)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(365),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
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
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('wc3stats_map')
            .setDescription('Replace all wc3stats→hero mappings (bulk)')
            .addStringOption((option) =>
              option
                .setName('entries')
                .setDescription('Pairs like 0=1,1=2,4=7 (wc3_slot=hero_slot)')
                .setRequired(true),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
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
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('wc3stats_host_prompt')
            .setDescription('Ping linked hosts when their wc3stats lobby appears')
            .addBooleanOption((option) =>
              option
                .setName('enabled')
                .setDescription('On: post Open lobby prompts for linked hosts')
                .setRequired(true),
            )
            .addChannelOption((option) =>
              option
                .setName('channel')
                .setDescription('Channel for host prompts (required when enabling)')
                .setRequired(false),
            ),
        ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('clear')
      .setDescription('Clear a bot configuration value')
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('leaderboard_channel')
            .setDescription('Remove the live overall leaderboard message binding'),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('leaderboard_size')
            .setDescription('Reset live leaderboard size to 10'),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
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
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('wc3stats_map')
            .setDescription('Remove all wc3stats→hero mappings for this server'),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('wc3stats')
            .setDescription('Disable wc3stats import and clear filter + slot map for this server'),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('wc3stats_host_prompt')
            .setDescription('Disable host lobby prompts and clear the prompt channel'),
        ),
      ),
  );

/** Resolve league from interaction; reply ephemeral on failure. */
async function requireLeagueId(
  interaction: ChatInputCommandInteraction,
): Promise<string | null> {
  const resolved = await resolveLeagueIdFromInteraction(interaction, getLeagueOption(interaction));
  if (!resolved.ok) {
    await interaction.reply({
      content: resolved.message,
      flags: MessageFlags.Ephemeral,
    });
  }
  return resolved.ok ? resolved.leagueId : null;
}

async function requireWc3statsLeague(
  interaction: ChatInputCommandInteraction,
): Promise<string | null> {
  const leagueId = await requireLeagueId(interaction);
  if (!leagueId) {
    return null;
  }

  try {
    await assertLeagueAllowsWc3stats(leagueId);
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.reply({
        content: error.message,
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }
    throw error;
  }

  return leagueId;
}

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
      const leagueContext = await resolveLeagueFromInteraction(
        interaction,
        getLeagueOption(interaction),
      );
      if (!leagueContext.ok) {
        await interaction.reply({
          content: leagueResolveFailureMessage(leagueContext.reason),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const leagueId = leagueContext.league.id;
      const leagueConfig = await resolveLeagueConfig(leagueId);
      const slotMaps = await listLeagueWc3statsSlotMaps(leagueId);

      await interaction.reply({
        content: [
          'Bot configuration for this server:',
          formatLeagueLine(leagueContext.league.name),
          formatRoleLine(
            'Create role',
            resolved.matchCreateRoleId,
            resolved.matchCreateRoleSource,
          ),
          formatRoleLine('Mod role', resolved.matchModRoleId, resolved.matchModRoleSource),
          formatLeaderboardLine(
            leagueConfig.leaderboardChannelId,
            leagueConfig.leaderboardMessageId,
            leagueConfig.leaderboardSize,
          ),
          formatPlayerClaimLine(leagueConfig.lobbyPlayerClaimEnabled),
          formatRankResetLine(
            leagueConfig.rankResetEnabled,
            leagueConfig.rankResetCooldownDays,
          ),
          formatWc3statsEnabledLine(leagueConfig.wc3statsEnabled),
          ...formatWc3statsFilterLines(
            leagueConfig.wc3statsMapPattern,
            leagueConfig.wc3statsMapSha1 ?? [],
          ),
          formatWc3statsHostPromptLine(
            leagueConfig.wc3statsHostPromptEnabled,
            leagueConfig.wc3statsHostPromptChannelId,
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
        const leagueId = await requireLeagueId(interaction);
        if (!leagueId) return;

        const enabled = interaction.options.getBoolean('enabled', true);
        await setLeagueLobbyPlayerClaimEnabled(leagueId, enabled);
        log.info(
          { guildId: interaction.guildId, leagueId, enabled, userId: interaction.user.id },
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

      if (subcommand === 'rank_reset') {
        const leagueId = await requireLeagueId(interaction);
        if (!leagueId) return;

        const enabled = interaction.options.getBoolean('enabled', true);
        const cooldownDays = interaction.options.getInteger('cooldown_days');
        try {
          await setLeagueRankResetEnabled(
            leagueId,
            enabled,
            cooldownDays ?? undefined,
          );
        } catch (error) {
          if (error instanceof RankResetServiceError) {
            await interaction.reply({
              content: error.message,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          throw error;
        }

        log.info(
          {
            guildId: interaction.guildId,
            leagueId,
            enabled,
            cooldownDays,
            userId: interaction.user.id,
          },
          'Rank reset setting updated',
        );
        const cooldownNote =
          cooldownDays != null ? ` Cooldown set to \`${cooldownDays}\` days.` : '';
        await interaction.reply({
          content: enabled
            ? `Rank reset enabled.${cooldownNote}`
            : 'Rank reset disabled.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'rank_reset_cooldown') {
        const leagueId = await requireLeagueId(interaction);
        if (!leagueId) return;

        const days = interaction.options.getInteger('days', true);
        try {
          await setLeagueRankResetCooldownDays(leagueId, days);
        } catch (error) {
          if (error instanceof RankResetServiceError) {
            await interaction.reply({
              content: error.message,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          throw error;
        }

        log.info(
          { guildId: interaction.guildId, leagueId, days, userId: interaction.user.id },
          'Rank reset cooldown updated',
        );
        await interaction.reply({
          content: `Rank reset cooldown set to \`${days}\` days.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'leaderboard_channel') {
        const leagueId = await requireLeagueId(interaction);
        if (!leagueId) return;

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

        await setupLiveLeaderboard(interaction.client, leagueId, channel.id);
        log.info(
          {
            guildId: interaction.guildId,
            leagueId,
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

      if (subcommand === 'leaderboard_size') {
        const leagueId = await requireLeagueId(interaction);
        if (!leagueId) return;

        const size = interaction.options.getInteger('size', true);
        try {
          await setLeagueLeaderboardSize(leagueId, size);
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

        await refreshLeagueLeaderboard(interaction.client, leagueId);
        log.info(
          { guildId: interaction.guildId, leagueId, size, userId: interaction.user.id },
          'Live leaderboard size updated',
        );
        await interaction.reply({
          content: `Live leaderboard size set to \`${size}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'wc3stats_slot') {
        const leagueId = await requireWc3statsLeague(interaction);
        if (!leagueId) return;

        const wc3Slot = interaction.options.getInteger('wc3_slot', true);
        const heroSlot = interaction.options.getInteger('hero_slot', true);
        await setLeagueWc3statsSlotMap(leagueId, wc3Slot, heroSlot);
        log.info(
          { guildId: interaction.guildId, leagueId, wc3Slot, heroSlot, userId: interaction.user.id },
          'wc3stats slot map entry updated',
        );
        await interaction.reply({
          content: `Mapped wc3stats slot \`${wc3Slot}\` → hero slot \`${heroSlot}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'wc3stats_map') {
        const leagueId = await requireWc3statsLeague(interaction);
        if (!leagueId) return;

        const entries = parseWc3statsSlotMapEntries(
          interaction.options.getString('entries', true),
        );
        await replaceLeagueWc3statsSlotMaps(leagueId, entries);
        log.info(
          { guildId: interaction.guildId, leagueId, count: entries.length, userId: interaction.user.id },
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
        const leagueId = await requireWc3statsLeague(interaction);
        if (!leagueId) return;

        const preset = interaction.options.getString('preset', true);
        if (preset !== 'udbr') {
          await interaction.reply({
            content: 'Unknown preset.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await applyUdbrWc3statsPreset(leagueId);
        log.info(
          { guildId: interaction.guildId, leagueId, preset, userId: interaction.user.id },
          'wc3stats package preset applied',
        );
        await interaction.reply({
          content: 'Applied UDBR preset: import enabled, map filter set, slot layout applied.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'wc3stats_host_prompt') {
        const leagueId = await requireWc3statsLeague(interaction);
        if (!leagueId) return;

        const enabled = interaction.options.getBoolean('enabled', true);
        if (!enabled) {
          await setLeagueWc3statsHostPrompt(leagueId, { enabled: false });
          log.info(
            { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
            'wc3stats host prompt disabled',
          );
          await interaction.reply({
            content: 'wc3stats host lobby prompt disabled.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const channel = interaction.options.getChannel('channel', false);
        if (!channel) {
          await interaction.reply({
            content: 'Choose a channel when enabling the wc3stats host lobby prompt.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const allowedTypes = new Set([
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ]);
        if (!allowedTypes.has(channel.type)) {
          await interaction.reply({
            content: 'Choose a server text channel for host lobby prompts.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await setLeagueWc3statsHostPrompt(leagueId, {
          enabled: true,
          channelId: channel.id,
        });
        log.info(
          {
            guildId: interaction.guildId,
            leagueId,
            channelId: channel.id,
            userId: interaction.user.id,
          },
          'wc3stats host prompt enabled',
        );
        await interaction.reply({
          content:
            `wc3stats host lobby prompt enabled in <#${channel.id}>. ` +
            'Linked hosts are pinged when their matching Warcraft lobby appears.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    if (subcommandGroup === 'clear') {
      if (subcommand === 'leaderboard_channel') {
        const leagueId = await requireLeagueId(interaction);
        if (!leagueId) return;

        await clearLiveLeaderboard(interaction.client, leagueId);
        log.info(
          { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
          'Live leaderboard channel cleared',
        );
        await interaction.reply({
          content: 'Live overall leaderboard cleared.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'leaderboard_size') {
        const leagueId = await requireLeagueId(interaction);
        if (!leagueId) return;

        await clearLeagueLeaderboardSize(leagueId);
        await refreshLeagueLeaderboard(interaction.client, leagueId);
        log.info(
          { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
          'Live leaderboard size cleared',
        );
        await interaction.reply({
          content: 'Live leaderboard size reset to `10`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'wc3stats_slot') {
        const leagueId = await requireWc3statsLeague(interaction);
        if (!leagueId) return;

        const wc3Slot = interaction.options.getInteger('wc3_slot', true);
        const removed = await clearLeagueWc3statsSlotMap(leagueId, wc3Slot);
        log.info(
          { guildId: interaction.guildId, leagueId, wc3Slot, removed, userId: interaction.user.id },
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
        const leagueId = await requireWc3statsLeague(interaction);
        if (!leagueId) return;

        await clearLeagueWc3statsPackage(leagueId);
        log.info(
          { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
          'wc3stats package cleared',
        );
        await interaction.reply({
          content:
            'wc3stats import disabled. Map filter and slot mappings cleared for this server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'wc3stats_host_prompt') {
        const leagueId = await requireWc3statsLeague(interaction);
        if (!leagueId) return;

        await clearLeagueWc3statsHostPrompt(leagueId);
        log.info(
          { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
          'wc3stats host prompt cleared',
        );
        await interaction.reply({
          content: 'wc3stats host lobby prompt disabled and channel cleared.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'wc3stats_map') {
        const leagueId = await requireWc3statsLeague(interaction);
        if (!leagueId) return;

        const removed = await clearAllLeagueWc3statsSlotMaps(leagueId);
        log.info(
          { guildId: interaction.guildId, leagueId, removed, userId: interaction.user.id },
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
