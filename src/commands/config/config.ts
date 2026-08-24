import { ChannelType, GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  assertCanConfigureBot,
  clearQuitterLeaderboardDisplay,
  clearQuitterLeaderboardSize,
  clearQuitterLeaderboardSort,
  clearGrieferLeaderboardDisplay,
  clearGrieferLeaderboardSize,
  clearGrieferLeaderboardSort,
  resolveGuildConfig,
  setMatchCreateRole,
  setMatchModRole,
  setQuitterLeaderboardDisplay,
  setQuitterLeaderboardSize,
  setQuitterLeaderboardSort,
  setGrieferLeaderboardDisplay,
  setGrieferLeaderboardSize,
  setGrieferLeaderboardSort,
  type GrieferLeaderboardDisplayValue,
  type GrieferLeaderboardSortValue,
  type QuitterLeaderboardDisplayValue,
  type QuitterLeaderboardSortValue,
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
  clearLeagueLobbyChannel,
  applyDecayPreset,
  clearDecayCrunchWindow,
  clearDecayModeSetting,
  clearDecayPrizeLock,
  clearDecayPrizeLockMinGames,
  clearDecayStreakCap,
  formatLobbyChannelConfigLine,
  getLeagueOption,
  isLeagueWritable,
  LEAGUE_ARCHIVED_MESSAGE,
  LEAGUE_DECAY_ARCHIVED_MESSAGE,
  leagueResolveFailureMessage,
  LOBBY_CHANNEL_SET_NEEDS_OPTION,
  resolveLeagueFromInteraction,
  respondLeagueAutocomplete,
  setDecayCrunchWindow,
  setDecayEnabled,
  setDecayModeSetting,
  setDecayPrizeLock,
  setDecayPrizeLockMinGames,
  setDecayStreakCap,
  setLeagueLobbyChannel,
  withSubcommandLeagueOption,
  type DecayMode,
  type DecayTunableKind,
} from '../../services/league/index.js';
import type { ResolvedDecaySettings } from '../../services/rating/decay-settings.js';
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
  assertGrieferLeaderboardSize,
  assertQuitterLeaderboardSize,
  clearGrieferLiveLeaderboard,
  clearLiveLeaderboard,
  clearQuitterLiveLeaderboard,
  LeaderboardServiceError,
  refreshGuildGrieferLeaderboard,
  refreshGuildQuitterLeaderboard,
  refreshLeagueLeaderboard,
  setupGrieferLiveLeaderboard,
  setupLiveLeaderboard,
  setupQuitterLiveLeaderboard,
} from '../../services/leaderboard/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import { RankResetServiceError } from '../../services/rating/index.js';
import {
  clearChangelogChannel,
  clearChangelogDraftChannel,
  postPendingStaffCards,
  ReleaseServiceError,
  setChangelogChannel,
  setChangelogDraftChannel,
} from '../../services/release/index.js';

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

function formatDecayLine(
  decayEnabled: boolean,
  seasonEndsAt: Date | undefined,
  decayInCrunch: boolean,
  settings: ResolvedDecaySettings,
): string {
  if (!decayEnabled) {
    return '**Rating decay:** `off`';
  }

  const parts = [
    '**Rating decay:** `on`',
    `mid grace \`${settings.midGraceDays}d\``,
    `mid −${settings.midTier1Ki}/−${settings.midTier2Ki} ki`,
    `streak cap \`${settings.midStreakCapKi === 0 ? 'none' : settings.midStreakCapKi}\``,
    `crunch grace \`${settings.crunchGraceDays}d\``,
    `crunch −${settings.crunchTier1Ki}/−${settings.crunchTier2Ki} ki`,
    `crunch window \`${settings.crunchWindowDays}d\``,
    `prize lock \`${settings.prizeLockEnabled ? 'on' : 'off'}\``,
    `prize min games \`${settings.prizeLockMinGames}\``,
  ];
  if (seasonEndsAt) {
    const unix = Math.floor(seasonEndsAt.getTime() / 1000);
    parts.push(`season ends <t:${unix}:F>`);
  }
  if (decayInCrunch) {
    parts.push('crunch active');
  }
  return parts.join(' · ');
}

function decayModeChoice() {
  return [
    { name: 'Mid-season', value: 'mid' },
    { name: 'Crunch', value: 'crunch' },
  ] as const;
}

function formatWc3statsHostPromptLine(enabled: boolean, channelId: string | undefined): string {
  if (!enabled || !channelId) {
    return '**wc3stats host lobby prompt:** `off`';
  }
  return `**wc3stats host lobby prompt:** \`on\` · <#${channelId}>`;
}

function formatWc3statsEnabledLine(enabled: boolean): string {
  return `**wc3stats import:** \`${enabled ? 'on' : 'off'}\``;
}

function formatWc3statsFilterLines(pattern: string | undefined, sha1: string[]): string[] {
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

function formatQuitterLeaderboardLine(
  channelId: string | undefined,
  messageId: string | undefined,
  size: number,
  display: string,
  sort: string,
): string {
  if (!channelId || !messageId) {
    return `**Quitter leaderboard:** \`unset\` · size \`${size}\` · display \`${display}\` · sort \`${sort}\``;
  }
  return `**Quitter leaderboard:** <#${channelId}> · message \`${messageId}\` · size \`${size}\` · display \`${display}\` · sort \`${sort}\``;
}

function formatGrieferLeaderboardLine(
  channelId: string | undefined,
  messageId: string | undefined,
  size: number,
  display: string,
  sort: string,
): string {
  if (!channelId || !messageId) {
    return `**Griefer leaderboard:** \`unset\` · size \`${size}\` · display \`${display}\` · sort \`${sort}\``;
  }
  return `**Griefer leaderboard:** <#${channelId}> · message \`${messageId}\` · size \`${size}\` · display \`${display}\` · sort \`${sort}\``;
}

function formatChangelogChannelLine(channelId: string | undefined): string {
  return channelId ? `**Changelog channel:** <#${channelId}>` : '**Changelog channel:** `unset`';
}

function formatChangelogDraftLine(channelId: string | undefined): string {
  return channelId
    ? `**Changelog draft channel:** <#${channelId}>`
    : '**Changelog draft channel:** `unset`';
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
  )
  .addSubcommandGroup((group) =>
    group
      .setName('decay')
      .setDescription('Tune per-league idle decay and crunch rates')
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('grace')
            .setDescription('Set mid-season or crunch idle grace days')
            .addStringOption((option) =>
              option
                .setName('mode')
                .setDescription('Mid-season or crunch')
                .setRequired(true)
                .addChoices(...decayModeChoice()),
            )
            .addIntegerOption((option) =>
              option
                .setName('days')
                .setDescription('Idle days before decay starts (0–90)')
                .setRequired(true)
                .setMinValue(0)
                .setMaxValue(90),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('tier1_ki')
            .setDescription('Set tier-1 daily ki loss (mid or crunch)')
            .addStringOption((option) =>
              option
                .setName('mode')
                .setDescription('Mid-season or crunch')
                .setRequired(true)
                .addChoices(...decayModeChoice()),
            )
            .addIntegerOption((option) =>
              option
                .setName('ki')
                .setDescription('Ki lost per day in tier 1 (0–500)')
                .setRequired(true)
                .setMinValue(0)
                .setMaxValue(500),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('tier2_ki')
            .setDescription('Set tier-2+ daily ki loss (mid or crunch)')
            .addStringOption((option) =>
              option
                .setName('mode')
                .setDescription('Mid-season or crunch')
                .setRequired(true)
                .addChoices(...decayModeChoice()),
            )
            .addIntegerOption((option) =>
              option
                .setName('ki')
                .setDescription('Ki lost per day in tier 2+ (0–500)')
                .setRequired(true)
                .setMinValue(0)
                .setMaxValue(500),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('tier1_span')
            .setDescription('Set how many days tier 1 lasts after grace (mid or crunch)')
            .addStringOption((option) =>
              option
                .setName('mode')
                .setDescription('Mid-season or crunch')
                .setRequired(true)
                .addChoices(...decayModeChoice()),
            )
            .addIntegerOption((option) =>
              option
                .setName('days')
                .setDescription('Days in tier 1 after grace (0–90)')
                .setRequired(true)
                .setMinValue(0)
                .setMaxValue(90),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('streak_cap')
            .setDescription('Set mid-season idle streak ki cap (0 = no cap)')
            .addIntegerOption((option) =>
              option
                .setName('ki')
                .setDescription('Max ki lost per idle streak (0–5000; 0 = none)')
                .setRequired(true)
                .setMinValue(0)
                .setMaxValue(5000),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('crunch_window')
            .setDescription('Set auto-crunch days before season end')
            .addIntegerOption((option) =>
              option
                .setName('days')
                .setDescription('Days before season end when crunch starts (1–90)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(90),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('prize_lock')
            .setDescription('Enable or disable prize-lock medals during crunch')
            .addBooleanOption((option) =>
              option
                .setName('enabled')
                .setDescription('On: medals require a finished-game minimum during crunch')
                .setRequired(true),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('prize_lock_min_games')
            .setDescription('Set finished games required for crunch medals')
            .addIntegerOption((option) =>
              option
                .setName('games')
                .setDescription('Minimum finished non-quit games in the crunch window (1–50)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(50),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('clear_prize_lock_min_games')
            .setDescription('Reset prize-lock min games to the code default (1)'),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('preset')
            .setDescription('Apply a named decay/crunch preset')
            .addStringOption((option) =>
              option
                .setName('name')
                .setDescription('Preset to apply')
                .setRequired(true)
                .addChoices({
                  name: 'Strict crunch (3d/−100ki / 7 games)',
                  value: 'strict_crunch',
                }),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('clear_grace')
            .setDescription('Reset mid or crunch grace days to the code default')
            .addStringOption((option) =>
              option
                .setName('mode')
                .setDescription('Mid-season or crunch')
                .setRequired(true)
                .addChoices(...decayModeChoice()),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('clear_tier1_ki')
            .setDescription('Reset mid or crunch tier-1 ki/day to the code default')
            .addStringOption((option) =>
              option
                .setName('mode')
                .setDescription('Mid-season or crunch')
                .setRequired(true)
                .addChoices(...decayModeChoice()),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('clear_tier2_ki')
            .setDescription('Reset mid or crunch tier-2 ki/day to the code default')
            .addStringOption((option) =>
              option
                .setName('mode')
                .setDescription('Mid-season or crunch')
                .setRequired(true)
                .addChoices(...decayModeChoice()),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('clear_tier1_span')
            .setDescription('Reset mid or crunch tier-1 span to the code default')
            .addStringOption((option) =>
              option
                .setName('mode')
                .setDescription('Mid-season or crunch')
                .setRequired(true)
                .addChoices(...decayModeChoice()),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('clear_streak_cap')
            .setDescription('Reset mid-season streak cap to the code default'),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('clear_crunch_window')
            .setDescription('Reset auto-crunch window days to the code default'),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('clear_prize_lock')
            .setDescription('Reset prize-lock toggle to the code default (on)'),
        ),
      ),
  );

/** Resolve league from interaction; reply ephemeral on failure. */
async function requireLeagueId(interaction: ChatInputCommandInteraction): Promise<string | null> {
  const resolved = await resolveLeagueFromInteraction(interaction, getLeagueOption(interaction));
  if (!resolved.ok) {
    await interaction.reply({
      content: leagueResolveFailureMessage(resolved.reason),
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  if (!isLeagueWritable(resolved.league)) {
    await interaction.reply({
      content: LEAGUE_ARCHIVED_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return resolved.league.id;
}

/** Resolve a writable league for decay config; uses decay-specific archived copy. */
async function requireWritableLeagueForDecay(
  interaction: ChatInputCommandInteraction,
): Promise<string | null> {
  const resolved = await resolveLeagueFromInteraction(interaction, getLeagueOption(interaction));
  if (!resolved.ok) {
    await interaction.reply({
      content: leagueResolveFailureMessage(resolved.reason),
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  if (!isLeagueWritable(resolved.league)) {
    await interaction.reply({
      content: LEAGUE_DECAY_ARCHIVED_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return resolved.league.id;
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
          formatRoleLine('Create role', resolved.matchCreateRoleId, resolved.matchCreateRoleSource),
          formatRoleLine('Mod role', resolved.matchModRoleId, resolved.matchModRoleSource),
          formatQuitterLeaderboardLine(
            resolved.quitterLeaderboardChannelId,
            resolved.quitterLeaderboardMessageId,
            resolved.quitterLeaderboardSize,
            resolved.quitterLeaderboardDisplay,
            resolved.quitterLeaderboardSort,
          ),
          formatGrieferLeaderboardLine(
            resolved.grieferLeaderboardChannelId,
            resolved.grieferLeaderboardMessageId,
            resolved.grieferLeaderboardSize,
            resolved.grieferLeaderboardDisplay,
            resolved.grieferLeaderboardSort,
          ),
          formatChangelogChannelLine(resolved.changelogChannelId),
          formatChangelogDraftLine(resolved.changelogDraftChannelId),
          formatLeaderboardLine(
            leagueConfig.leaderboardChannelId,
            leagueConfig.leaderboardMessageId,
            leagueConfig.leaderboardSize,
          ),
          formatPlayerClaimLine(leagueConfig.lobbyPlayerClaimEnabled),
          formatLobbyChannelConfigLine(
            leagueConfig.lobbyChannelEnabled,
            leagueConfig.lobbyChannelId,
          ),
          formatRankResetLine(leagueConfig.rankResetEnabled, leagueConfig.rankResetCooldownDays),
          formatDecayLine(
            leagueConfig.decayEnabled,
            leagueConfig.seasonEndsAt,
            leagueConfig.decayInCrunch,
            leagueConfig.decaySettings,
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
        const cooldownNote =
          cooldownDays != null ? ` Cooldown set to \`${cooldownDays}\` days.` : '';
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

    if (subcommandGroup === 'decay') {
      const leagueId = await requireWritableLeagueForDecay(interaction);
      if (!leagueId) return;

      if (
        subcommand === 'grace' ||
        subcommand === 'tier1_ki' ||
        subcommand === 'tier2_ki' ||
        subcommand === 'tier1_span'
      ) {
        const mode = interaction.options.getString('mode', true) as DecayMode;
        const kind = subcommand as DecayTunableKind;

        try {
          if (subcommand === 'grace' || subcommand === 'tier1_span') {
            const days = interaction.options.getInteger('days', true);
            await setDecayModeSetting(leagueId, kind, mode, days);
            await interaction.reply({
              content: `Decay ${kind.replace(/_/g, ' ')} (${mode}) set to \`${days}\`.`,
              flags: MessageFlags.Ephemeral,
            });
          } else {
            const ki = interaction.options.getInteger('ki', true);
            await setDecayModeSetting(leagueId, kind, mode, ki);
            await interaction.reply({
              content: `Decay ${kind.replace(/_/g, ' ')} (${mode}) set to \`${ki}\` ki/day.`,
              flags: MessageFlags.Ephemeral,
            });
          }
        } catch (error) {
          if (error instanceof Error) {
            await interaction.reply({
              content: error.message,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          throw error;
        }

        log.info(
          { guildId: interaction.guildId, leagueId, subcommand, mode, userId: interaction.user.id },
          'Rating decay tunable updated',
        );
        return;
      }

      if (subcommand === 'streak_cap') {
        const ki = interaction.options.getInteger('ki', true);
        try {
          await setDecayStreakCap(leagueId, ki);
        } catch (error) {
          if (error instanceof Error) {
            await interaction.reply({
              content: error.message,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          throw error;
        }
        log.info(
          { guildId: interaction.guildId, leagueId, ki, userId: interaction.user.id },
          'Rating decay streak cap updated',
        );
        await interaction.reply({
          content:
            ki === 0
              ? 'Mid-season decay streak cap disabled (no cap).'
              : `Mid-season decay streak cap set to \`${ki}\` ki.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'crunch_window') {
        const days = interaction.options.getInteger('days', true);
        try {
          await setDecayCrunchWindow(leagueId, days);
        } catch (error) {
          if (error instanceof Error) {
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
          'Rating decay crunch window updated',
        );
        await interaction.reply({
          content: `Auto-crunch window set to \`${days}\` days before season end.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'prize_lock') {
        const enabled = interaction.options.getBoolean('enabled', true);
        await setDecayPrizeLock(leagueId, enabled);
        log.info(
          { guildId: interaction.guildId, leagueId, enabled, userId: interaction.user.id },
          'Rating decay prize lock updated',
        );
        await interaction.reply({
          content: enabled
            ? 'Prize-lock medals enabled during crunch.'
            : 'Prize-lock medals disabled during crunch.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'prize_lock_min_games') {
        const games = interaction.options.getInteger('games', true);
        try {
          await setDecayPrizeLockMinGames(leagueId, games);
        } catch (error) {
          if (error instanceof Error) {
            await interaction.reply({
              content: error.message,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          throw error;
        }
        log.info(
          { guildId: interaction.guildId, leagueId, games, userId: interaction.user.id },
          'Rating decay prize lock min games updated',
        );
        await interaction.reply({
          content: `Prize-lock minimum set to \`${games}\` finished games.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'clear_prize_lock_min_games') {
        await clearDecayPrizeLockMinGames(leagueId);
        log.info(
          { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
          'Rating decay prize lock min games cleared',
        );
        await interaction.reply({
          content: 'Prize-lock minimum reset to the code default (1).',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'preset') {
        const name = interaction.options.getString('name', true);
        try {
          await applyDecayPreset(leagueId, name);
        } catch (error) {
          if (error instanceof Error) {
            await interaction.reply({
              content: error.message,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          throw error;
        }
        log.info(
          { guildId: interaction.guildId, leagueId, preset: name, userId: interaction.user.id },
          'Rating decay preset applied',
        );
        await interaction.reply({
          content:
            'Applied decay preset `strict_crunch` (crunch grace 3d, −100/−100 ki/day, window 7d, medals need 7 games).',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (
        subcommand === 'clear_grace' ||
        subcommand === 'clear_tier1_ki' ||
        subcommand === 'clear_tier2_ki' ||
        subcommand === 'clear_tier1_span'
      ) {
        const mode = interaction.options.getString('mode', true) as DecayMode;
        const kind = (
          {
            clear_grace: 'grace',
            clear_tier1_ki: 'tier1_ki',
            clear_tier2_ki: 'tier2_ki',
            clear_tier1_span: 'tier1_span',
          } as const
        )[subcommand] as DecayTunableKind;

        await clearDecayModeSetting(leagueId, kind, mode);
        log.info(
          { guildId: interaction.guildId, leagueId, subcommand, mode, userId: interaction.user.id },
          'Rating decay tunable cleared',
        );
        await interaction.reply({
          content: `Decay ${kind.replace(/_/g, ' ')} (${mode}) reset to the code default.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'clear_streak_cap') {
        await clearDecayStreakCap(leagueId);
        log.info(
          { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
          'Rating decay streak cap cleared',
        );
        await interaction.reply({
          content: 'Mid-season decay streak cap reset to the code default.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'clear_crunch_window') {
        await clearDecayCrunchWindow(leagueId);
        log.info(
          { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
          'Rating decay crunch window cleared',
        );
        await interaction.reply({
          content: 'Auto-crunch window reset to the code default.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'clear_prize_lock') {
        await clearDecayPrizeLock(leagueId);
        log.info(
          { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
          'Rating decay prize lock cleared',
        );
        await interaction.reply({
          content: 'Prize-lock toggle reset to the code default (on).',
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
