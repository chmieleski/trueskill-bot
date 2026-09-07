import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  applyUdbrWc3statsPreset,
  applyWc3statsMapPreset,
  applyWosWc3statsPreset,
  clearLeagueLeaderboardSize,
  clearLeagueWc3statsHostPrompt,
  clearLeagueWc3statsPackage,
  resolveLeagueConfig,
  setLeagueLeaderboardSize,
  setLeagueLobbyPlayerClaimEnabled,
  setLeagueRankResetCooldownDays,
  setLeagueRankResetEnabled,
  setLeagueWc3statsHostPrompt,
  setLeagueWc3statsHostPromptPings,
} from '../../services/league/league-wc3stats.js';
import {
  clearLeagueLobbyChannel,
  createOrRotateLeagueApiToken,
  formatLobbyChannelConfigLine,
  LOBBY_CHANNEL_SET_NEEDS_OPTION,
  respondLeagueAutocomplete,
  revokeLeagueApiToken,
  setDecayEnabled,
  setLeagueLobbyChannel,
  setLeagueMatchApprovalChannel,
  withSubcommandLeagueOption,
} from '../../services/league/index.js';
import {
  setBalanceStaticSigmaEnabled,
  setShowSideWinLoss,
} from '../../services/league/league-balance-config.js';
import { BALANCE_STATIC_SIGMA } from '../../services/rating/rating-entities.js';
import {
  clearAllLeagueWc3statsSlotMaps,
  clearLeagueWc3statsSlotMap,
  formatWc3statsSlotMapLines,
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
import {
  assertConfigStaff,
  requireLeagueId,
  requireWc3statsLeague,
  requireWritableLeagueForDecay,
} from './config-shared.js';

const log = createLogger('league_config_cmd');

export const data = new SlashCommandBuilder()
  .setName('league_config')
  .setDescription('View or set per-league bot configuration')
  .addSubcommandGroup((group) =>
    group
      .setName('set')
      .setDescription('Set a league configuration value')
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('leaderboard_channel')
            .setDescription('Channel for the live overall leaderboard')
            .addChannelOption((option) =>
              option
                .setName('channel')
                .setDescription('Channel for the live leaderboard message')
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
            .setName('lobby_channel')
            .setDescription('Require lobby creation in a dedicated channel')
            .addBooleanOption((option) =>
              option
                .setName('enabled')
                .setDescription('On: only create lobbies in the chosen channel')
                .setRequired(false),
            )
            .addChannelOption((option) =>
              option
                .setName('channel')
                .setDescription('Dedicated lobby channel (required when first enabling)')
                .setRequired(false),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('match_approval_channel')
            .setDescription('Channel for HTTP match approval posts')
            .addChannelOption((option) =>
              option
                .setName('channel')
                .setDescription('Text channel for approval messages')
                .setRequired(false),
            )
            .addBooleanOption((option) =>
              option
                .setName('clear')
                .setDescription('Clear approval channel (ignores channel)')
                .setRequired(false),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('api_token')
            .setDescription('Rotate or revoke the league HTTP API token')
            .addStringOption((option) =>
              option
                .setName('action')
                .setDescription('rotate = new token; revoke = clear')
                .setRequired(true)
                .addChoices(
                  { name: 'rotate', value: 'rotate' },
                  { name: 'revoke', value: 'revoke' },
                ),
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
                .setDescription('On: /rank_reset allowed. Off: rejected.')
                .setRequired(true),
            )
            .addIntegerOption((option) =>
              option
                .setName('cooldown_days')
                .setDescription('Days between self-resets (1–365); optional')
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
            .setName('decay')
            .setDescription('Enable or disable idle rating decay for this league')
            .addBooleanOption((option) =>
              option
                .setName('enabled')
                .setDescription('On: idle players lose ki over time. Off: no decay.')
                .setRequired(true),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('balance_static_sigma')
            .setDescription('Fixed σ for lobby win% / balance (ki apply stays dynamic)')
            .addBooleanOption((option) =>
              option
                .setName('enabled')
                .setDescription('On: fixed σ for balance. Off: persisted σ.')
                .setRequired(true),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('side_win_loss')
            .setDescription('Show side W–L on /rank (ZF/Evil or Team A/B)')
            .addBooleanOption((option) =>
              option
                .setName('enabled')
                .setDescription('On: side W–L on /rank. Off: hide it.')
                .setRequired(true),
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
                .setDescription('0-based wc3stats slots[] index (color order)')
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
                .addChoices(
                  { name: 'UDBR (Z Fighters / Evils)', value: 'udbr' },
                  { name: 'WOS (Team A / Team B)', value: 'wos' },
                ),
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
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('wc3stats_host_prompt_pings')
            .setDescription('Allow or block wc3stats host @-mentions')
            .addBooleanOption((option) =>
              option
                .setName('enabled')
                .setDescription('Off: no host pings until staff re-enable')
                .setRequired(true),
            ),
        ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('clear')
      .setDescription('Clear a league configuration value')
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('leaderboard_channel')
            .setDescription('Remove the live overall leaderboard binding'),
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
            .setName('lobby_channel')
            .setDescription('Disable the lobby channel gate and forget the channel'),
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
            .setDescription('Disable wc3stats import and clear filter + slot map'),
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
    assertConfigStaff(interaction);
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

  const subcommandGroup = interaction.options.getSubcommandGroup(true);
  const subcommand = interaction.options.getSubcommand(true);

  if (subcommandGroup === 'set') {
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

    if (subcommand === 'lobby_channel') {
      const leagueId = await requireLeagueId(interaction);
      if (!leagueId) return;

      const enabled = interaction.options.getBoolean('enabled');
      const channel = interaction.options.getChannel('channel', false);

      if (enabled === null && !channel) {
        await interaction.reply({
          content: LOBBY_CHANNEL_SET_NEEDS_OPTION,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (channel) {
        const allowedTypes = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
        if (!allowedTypes.has(channel.type)) {
          await interaction.reply({
            content: 'Choose a server text channel for lobbies.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }

      await setLeagueLobbyChannel(leagueId, {
        ...(enabled !== null ? { enabled } : {}),
        ...(channel ? { channelId: channel.id } : {}),
      });

      const updated = await resolveLeagueConfig(leagueId);
      log.info(
        {
          guildId: interaction.guildId,
          leagueId,
          enabled: updated.lobbyChannelEnabled,
          channelId: updated.lobbyChannelId,
          userId: interaction.user.id,
        },
        'Lobby channel setting updated',
      );
      await interaction.reply({
        content: formatLobbyChannelConfigLine(
          updated.lobbyChannelEnabled,
          updated.lobbyChannelId,
        ).replace('**Lobby channel:** ', 'Lobby channel: '),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'match_approval_channel') {
      const leagueId = await requireLeagueId(interaction);
      if (!leagueId) return;

      const clear = interaction.options.getBoolean('clear') === true;
      const channel = interaction.options.getChannel('channel', false);

      if (clear) {
        await setLeagueMatchApprovalChannel(leagueId, null);
        log.info(
          { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
          'Match approval channel cleared',
        );
        await interaction.reply({
          content: 'Match approval channel cleared.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!channel) {
        await interaction.reply({
          content: 'Choose a channel, or pass clear:true to remove it.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const allowedTypes = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
      if (!allowedTypes.has(channel.type)) {
        await interaction.reply({
          content: 'Choose a server text channel for match approval.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await setLeagueMatchApprovalChannel(leagueId, channel.id);
      log.info(
        {
          guildId: interaction.guildId,
          leagueId,
          channelId: channel.id,
          userId: interaction.user.id,
        },
        'Match approval channel updated',
      );
      await interaction.reply({
        content: `Match approval channel set to <#${channel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'api_token') {
      const leagueId = await requireLeagueId(interaction);
      if (!leagueId) return;

      const action = interaction.options.getString('action', true);
      if (action === 'revoke') {
        await revokeLeagueApiToken(leagueId);
        log.info(
          { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
          'League API token revoked',
        );
        await interaction.reply({
          content: 'API token revoked.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (action !== 'rotate') {
        await interaction.reply({
          content: 'Unknown api_token action.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const { plaintext } = await createOrRotateLeagueApiToken(leagueId);
      log.info(
        { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
        'League API token rotated',
      );
      await interaction.reply({
        content: [
          'API token rotated. Copy it now — it is shown only once:',
          `\`${plaintext}\``,
          'Store it securely. Anyone with this token can submit match results for this league.',
        ].join('\n'),
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
        await setLeagueRankResetEnabled(leagueId, enabled, cooldownDays ?? undefined);
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
      const cooldownNote = cooldownDays != null ? ` Cooldown set to \`${cooldownDays}\` days.` : '';
      await interaction.reply({
        content: enabled ? `Rank reset enabled.${cooldownNote}` : 'Rank reset disabled.',
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

    if (subcommand === 'decay') {
      const leagueId = await requireWritableLeagueForDecay(interaction);
      if (!leagueId) return;

      const enabled = interaction.options.getBoolean('enabled', true);
      await setDecayEnabled(leagueId, enabled);
      log.info(
        { guildId: interaction.guildId, leagueId, enabled, userId: interaction.user.id },
        'Rating decay setting updated',
      );
      await interaction.reply({
        content: enabled ? 'Rating decay enabled.' : 'Rating decay disabled.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'balance_static_sigma') {
      const leagueId = await requireWritableLeagueForDecay(interaction);
      if (!leagueId) return;

      const enabled = interaction.options.getBoolean('enabled', true);
      await setBalanceStaticSigmaEnabled(leagueId, enabled);
      log.info(
        { guildId: interaction.guildId, leagueId, enabled, userId: interaction.user.id },
        'Lobby balance static sigma setting updated',
      );
      await interaction.reply({
        content: enabled
          ? `Lobby balance uses static σ (${BALANCE_STATIC_SIGMA}). Ki apply is unchanged.`
          : 'Lobby balance uses each player’s persisted σ again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'side_win_loss') {
      const leagueId = await requireLeagueId(interaction);
      if (!leagueId) return;

      const enabled = interaction.options.getBoolean('enabled', true);
      await setShowSideWinLoss(leagueId, enabled);
      log.info(
        { guildId: interaction.guildId, leagueId, enabled, userId: interaction.user.id },
        'Rank side W/L setting updated',
      );
      await interaction.reply({
        content: enabled ? 'Side W–L line enabled on /rank.' : 'Side W–L line disabled on /rank.',
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
        {
          guildId: interaction.guildId,
          leagueId,
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
      const leagueId = await requireWc3statsLeague(interaction);
      if (!leagueId) return;

      const entries = parseWc3statsSlotMapEntries(interaction.options.getString('entries', true));
      await replaceLeagueWc3statsSlotMaps(leagueId, entries);
      log.info(
        {
          guildId: interaction.guildId,
          leagueId,
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
      const leagueId = await requireWc3statsLeague(interaction);
      if (!leagueId) return;

      const preset = interaction.options.getString('preset', true) as 'udbr' | 'wos';
      if (preset !== 'udbr' && preset !== 'wos') {
        await interaction.reply({
          content: 'Unknown preset.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await applyWc3statsMapPreset(leagueId, preset);
      log.info(
        { guildId: interaction.guildId, leagueId, preset, userId: interaction.user.id },
        'wc3stats package preset applied',
      );
      const presetLabel = preset === 'udbr' ? 'UDBR' : 'WOS';
      await interaction.reply({
        content: `Applied ${presetLabel} preset: import enabled, map filter set, slot layout applied.`,
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

      const allowedTypes = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
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

    if (subcommand === 'wc3stats_host_prompt_pings') {
      const leagueId = await requireWc3statsLeague(interaction);
      if (!leagueId) return;

      const enabled = interaction.options.getBoolean('enabled', true);
      await setLeagueWc3statsHostPromptPings(leagueId, enabled);
      log.info(
        {
          guildId: interaction.guildId,
          leagueId,
          enabled,
          userId: interaction.user.id,
        },
        'wc3stats host prompt pings updated',
      );
      await interaction.reply({
        content: enabled
          ? 'wc3stats host lobby pings enabled for everyone (players who opted out in `/settings` are still skipped).'
          : 'wc3stats host lobby pings disabled for everyone. Host prompt channel settings are unchanged.',
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

    if (subcommand === 'lobby_channel') {
      const leagueId = await requireLeagueId(interaction);
      if (!leagueId) return;

      await clearLeagueLobbyChannel(leagueId);
      log.info(
        { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
        'Lobby channel cleared',
      );
      await interaction.reply({
        content: 'Lobby channel disabled and channel cleared.',
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
        content: 'wc3stats import disabled. Map filter and slot mappings cleared for this server.',
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
    content: 'Unknown league config subcommand.',
    flags: MessageFlags.Ephemeral,
  });
}
