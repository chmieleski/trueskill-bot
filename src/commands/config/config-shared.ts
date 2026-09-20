import { GuildMember, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import {
  assertCanConfigureBot,
  canConfigureBot,
  resolveGuildConfig,
  type RoleConfigSource,
} from '../../services/guild/index.js';
import {
  assertLeagueAllowsWc3stats,
  resolveLeagueConfig,
} from '../../services/league/league-wc3stats.js';
import {
  formatLobbyChannelConfigLine,
  getLeagueOption,
  isLeagueWritable,
  LEAGUE_ARCHIVED_MESSAGE,
  LEAGUE_DECAY_ARCHIVED_MESSAGE,
  leagueResolveFailureMessage,
  resolveLeagueFromInteraction,
} from '../../services/league/index.js';
import { BALANCE_STATIC_SIGMA } from '../../services/rating/rating-entities.js';
import type { ResolvedDecaySettings } from '../../services/rating/decay-settings.js';
import {
  formatWc3statsSlotMapLines,
  listLeagueWc3statsSlotMaps,
} from '../../services/wc3stats/index.js';
import { listLeagueHeroChampionRoles } from '../../services/hero-champion-roles/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import { assertHasMatchModRole } from '../../services/match/match-auth.js';

/** Read member permissions from a slash interaction. */
export function memberPermissions(interaction: ChatInputCommandInteraction) {
  const member = interaction.member;

  if (member instanceof GuildMember) {
    return member.permissions;
  }

  if (member && typeof member === 'object' && 'permissions' in member) {
    return (member as { permissions: string }).permissions;
  }

  return null;
}

/** Collect Discord role snowflakes from a slash interaction member. */
export function memberRoleIds(interaction: { member: unknown }): string[] {
  const member = interaction.member;
  if (!(member instanceof GuildMember)) {
    return [];
  }
  return [...member.roles.cache.keys()];
}

/** Reject users who may not change bot configuration. */
export function assertConfigStaff(interaction: ChatInputCommandInteraction): void {
  assertCanConfigureBot({
    userId: interaction.user.id,
    memberPermissions: memberPermissions(interaction),
  });
}

/** Allow server admins or match moderators to configure the completed-match log channel. */
export async function assertCanSetMatchLogChannel(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (
    canConfigureBot({
      userId: interaction.user.id,
      memberPermissions: memberPermissions(interaction),
    })
  ) {
    return;
  }

  if (!interaction.guildId) {
    throw new MatchServiceError('This command can only be used in a server.');
  }

  const config = await resolveGuildConfig(interaction.guildId);
  assertHasMatchModRole({
    actorDiscordId: interaction.user.id,
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId: config.matchModRoleId,
  });
}

export function formatRoleLine(
  label: string,
  roleId: string | undefined,
  source: RoleConfigSource,
): string {
  const value = roleId ? `<@&${roleId}> (\`${roleId}\`)` : '`unset`';
  return `**${label}:** ${value} — source: \`${source}\``;
}

export function formatPlayerClaimLine(enabled: boolean): string {
  return `**Player claim:** \`${enabled ? 'on' : 'off'}\``;
}

export function formatRankResetLine(enabled: boolean, cooldownDays: number): string {
  return `**Rank reset:** \`${enabled ? 'on' : 'off'}\` · cooldown \`${cooldownDays}d\``;
}

export function formatBalanceStaticSigmaLine(enabled: boolean): string {
  return enabled
    ? `**Lobby balance σ:** static (\`${BALANCE_STATIC_SIGMA}\`)`
    : '**Lobby balance σ:** dynamic';
}

export function formatSideWinLossLine(enabled: boolean): string {
  return `**Rank side W–L:** \`${enabled ? 'on' : 'off'}\``;
}

export function formatDecayLine(
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

export function formatWc3statsHostPromptLine(
  enabled: boolean,
  channelId: string | undefined,
  pingsEnabled = true,
): string {
  if (!enabled || !channelId) {
    return '**wc3stats host lobby prompt:** `off`';
  }
  const pings = pingsEnabled ? 'on' : 'off';
  return `**wc3stats host lobby prompt:** \`on\` · <#${channelId}> · pings \`${pings}\``;
}

export function formatWc3statsEnabledLine(enabled: boolean): string {
  return `**wc3stats import:** \`${enabled ? 'on' : 'off'}\``;
}

export function formatWc3statsFilterLines(pattern: string | undefined, sha1: string[]): string[] {
  return [
    `**wc3stats map pattern:** ${pattern ? `\`${pattern}\`` : '`unset`'}`,
    `**wc3stats map sha1:** ${
      sha1.length > 0 ? sha1.map((s) => `\`${s}\``).join(', ') : '`unset`'
    }`,
  ];
}

export function formatWc3statsMapSection(lines: string[]): string {
  return ['**wc3stats → hero slots:**', ...lines.map((line) => `• ${line}`)].join('\n');
}

export function formatLeaderboardLine(
  channelId: string | undefined,
  messageId: string | undefined,
  size: number,
): string {
  if (!channelId || !messageId) {
    return `**Live leaderboard:** \`unset\` · size \`${size}\``;
  }
  return `**Live leaderboard:** <#${channelId}> · message \`${messageId}\` · size \`${size}\``;
}

export function formatQuitterLeaderboardLine(
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

export function formatGrieferLeaderboardLine(
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

export function formatChangelogChannelLine(channelId: string | undefined): string {
  return channelId ? `**Changelog channel:** <#${channelId}>` : '**Changelog channel:** `unset`';
}

export function formatChangelogDraftLine(channelId: string | undefined): string {
  return channelId
    ? `**Changelog draft channel:** <#${channelId}>`
    : '**Changelog draft channel:** `unset`';
}

export function formatCompletedMatchLogLine(channelId: string | undefined): string {
  return channelId
    ? `**Completed match log:** <#${channelId}>`
    : '**Completed match log:** `unset`';
}

export function formatLeagueLine(name: string | undefined): string {
  return `**League:** ${name ? `\`${name}\`` : '`unset`'}`;
}

export function formatMatchApprovalChannelLine(channelId: string | undefined): string {
  return channelId
    ? `**Match approval channel:** <#${channelId}>`
    : '**Match approval channel:** `not set`';
}

export function formatApiTokenConfigLine(
  apiTokenSet: boolean,
  apiTokenCreatedAt: Date | undefined,
): string {
  if (!apiTokenSet) {
    return '**API token:** `not set`';
  }
  if (apiTokenCreatedAt) {
    const unix = Math.floor(apiTokenCreatedAt.getTime() / 1000);
    return `**API token:** \`set\` · rotated <t:${unix}:R>`;
  }
  return '**API token:** `set`';
}

export function formatHeroChampionRolesLine(
  enabled: boolean,
  mappings: {
    heroId: number;
    heroName: string;
    discordRoleId: string;
    holderDiscordId: string | null;
  }[],
): string {
  const header = `**Hero champion roles:** \`${enabled ? 'on' : 'off'}\``;
  if (mappings.length === 0) {
    return `${header} · no heroes mapped`;
  }
  const lines = mappings.map((m) => {
    const holder = m.holderDiscordId ? `<@${m.holderDiscordId}>` : '`none`';
    return `• ${m.heroName} (\`${m.heroId}\`) → <@&${m.discordRoleId}> · holder ${holder}`;
  });
  return [header, ...lines].join('\n');
}

/** Build `/config view` output for guild-wide and league-scoped settings. */
export async function buildConfigViewContent(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<string | null> {
  const resolved = await resolveGuildConfig(guildId);
  const leagueContext = await resolveLeagueFromInteraction(
    interaction,
    getLeagueOption(interaction),
  );
  if (!leagueContext.ok) {
    return leagueResolveFailureMessage(leagueContext.reason);
  }

  const leagueId = leagueContext.league.id;
  const leagueConfig = await resolveLeagueConfig(leagueId);
  const slotMaps = await listLeagueWc3statsSlotMaps(leagueId);
  const heroChampionRoles = await listLeagueHeroChampionRoles(leagueId);

  return [
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
    formatCompletedMatchLogLine(resolved.completedMatchLogChannelId),
    formatLeaderboardLine(
      leagueConfig.leaderboardChannelId,
      leagueConfig.leaderboardMessageId,
      leagueConfig.leaderboardSize,
    ),
    formatPlayerClaimLine(leagueConfig.lobbyPlayerClaimEnabled),
    formatLobbyChannelConfigLine(leagueConfig.lobbyChannelEnabled, leagueConfig.lobbyChannelId),
    formatMatchApprovalChannelLine(leagueConfig.matchApprovalChannelId),
    formatApiTokenConfigLine(leagueConfig.apiTokenSet, leagueConfig.apiTokenCreatedAt),
    formatRankResetLine(leagueConfig.rankResetEnabled, leagueConfig.rankResetCooldownDays),
    formatBalanceStaticSigmaLine(leagueConfig.balanceStaticSigmaEnabled),
    formatSideWinLossLine(leagueConfig.showSideWinLoss),
    formatHeroChampionRolesLine(leagueConfig.heroChampionRolesEnabled, heroChampionRoles),
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
      leagueConfig.wc3statsHostPromptPingsEnabled,
    ),
    formatWc3statsMapSection(formatWc3statsSlotMapLines(slotMaps)),
  ].join('\n');
}

/** Resolve league from interaction; reply ephemeral on failure. */
export async function requireLeagueId(
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
      content: LEAGUE_ARCHIVED_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return resolved.league.id;
}

/** Resolve a writable league for decay config; uses decay-specific archived copy. */
export async function requireWritableLeagueForDecay(
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

export async function requireWc3statsLeague(
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
