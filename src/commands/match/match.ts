import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  InteractionReplyOptions,
} from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { syncLobbyDiscordMessage } from '../../services/lobby/index.js';
import { resolveGuildConfig, teamDisplayName, winnerLabel } from '../../services/guild/index.js';
import { assertCanManageMatch } from '../../services/match/index.js';
import {
  refreshAllLeaderboardChannels,
  refreshGuildGrieferLeaderboard,
  refreshGuildQuitterLeaderboard,
  refreshLeagueLeaderboard,
} from '../../services/leaderboard/index.js';
import {
  cancelInProgressMatch,
  clearMatchGriefers,
  clearMatchQuitters,
  completeMatch,
  fetchTextAttachment,
  hasMatchStatsReport,
  isTextReportAttachment,
  setGriefers,
  setQuitters,
  uploadMatchStatsReport,
  WOS_MATCH_REPORT_REQUIRED_MESSAGE,
  addManualSanction,
  removeManualSanction,
  requestMitigationApproval,
  type ManualSanctionType,
} from '../../services/match/index.js';
import {
  normalizeMitigationPercent,
  type RatingMitigationPercent,
} from '../../services/rating/rating-mitigation.js';
import {
  assertHasMatchModRole,
  buildMatchHistoryEmbed,
  buildMatchHistoryPageButtons,
  buildMatchListEmbed,
  buildMatchListPageButtons,
  findInProgressMatchesByHost,
  getMatchById,
  hasMatchModRole,
  loadCompletedMatchShow,
  loadMatchHistoryPage,
  loadMatchListPage,
  MatchServiceError,
  previewMatchCorrection,
  resolveHistoryPlayer,
  getGameProfileForMatch,
  requireLeagueId,
  type ClearedMatchQuitter,
  type MatchWithPlayers,
} from '../../services/match/index.js';
import { buildMatchCorrectionConfirmComponents } from '../../discord/interactions/match-correction-interactions.js';
import type { LobbyRatingPreview } from '../../services/rating/index.js';
import {
  getGameProfileForLeague,
  getLeagueOption,
  resolveLeagueIdFromInteraction,
  respondAllLeagueAutocomplete,
  withSubcommandLeagueOption,
} from '../../services/league/index.js';
import { ensurePlayerForModLookup, parseRankOptions } from '../../services/player/index.js';

const log = createLogger('match_cmd');

const MIN_SLOT = 1;
const MAX_SLOT = 12;

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

function hasMatchModeratorRole(
  interaction: { user: { id: string }; member: unknown },
  matchModRoleId: string | undefined,
): boolean {
  return hasMatchModRole({
    actorDiscordId: interaction.user.id,
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId,
  });
}

export function parseQuitterSlots(slotsRaw: string | null | undefined): number[] {
  const trimmed = slotsRaw?.trim();

  if (!trimmed) {
    return [];
  }

  const slots = new Set<number>();

  for (const token of trimmed.split(',')) {
    const value = token.trim();

    if (!value) {
      continue;
    }

    const slot = Number(value);

    if (!Number.isInteger(slot) || slot < MIN_SLOT || slot > MAX_SLOT) {
      throw new MatchServiceError(
        `Invalid quitter slot "${value}". Slots must be between ${MIN_SLOT} and ${MAX_SLOT}.`,
      );
    }

    slots.add(slot);
  }

  return [...slots].sort((a, b) => a - b);
}

export function parseGrieferSlots(slotsRaw: string | null | undefined): number[] {
  const trimmed = slotsRaw?.trim();

  if (!trimmed) {
    return [];
  }

  const slots = new Set<number>();

  for (const token of trimmed.split(',')) {
    const value = token.trim();

    if (!value) {
      continue;
    }

    const slot = Number(value);

    if (!Number.isInteger(slot) || slot < MIN_SLOT || slot > MAX_SLOT) {
      throw new MatchServiceError(
        `Invalid griefer slot "${value}". Slots must be between ${MIN_SLOT} and ${MAX_SLOT}.`,
      );
    }

    slots.add(slot);
  }

  return [...slots].sort((a, b) => a - b);
}

/** Collect quitter slot numbers from a completed match roster. */
export function quitterSlotsFromPlayers(
  players: Array<{ slot: number; isQuitter: boolean }>,
): number[] {
  return players.filter((p) => p.isQuitter).map((p) => p.slot);
}

function parseWinner(winner: string): 1 | 2 {
  if (winner === 'A') {
    return 1;
  }

  if (winner === 'B') {
    return 2;
  }

  throw new MatchServiceError('Invalid winning team selection.');
}

async function resolveMatchForCommand(
  interaction: ChatInputCommandInteraction,
  matchId: string | null,
): Promise<MatchWithPlayers> {
  if (!interaction.guildId) {
    throw new MatchServiceError('This command can only be used in a server.');
  }

  const config = await resolveGuildConfig(interaction.guildId);
  const roles = memberRoleIds(interaction);

  if (matchId) {
    const match = await getMatchById(matchId);

    if (!match) {
      throw new MatchServiceError('This match was not found.');
    }

    if (match.status !== 'IN_PROGRESS') {
      throw new MatchServiceError('This match is not in progress.');
    }

    assertCanManageMatch({
      hostDiscordId: match.hostDiscordId,
      actorDiscordId: interaction.user.id,
      memberRoleIds: roles,
      matchModRoleId: config.matchModRoleId,
    });

    return match;
  }

  const matches = await findInProgressMatchesByHost(interaction.user.id);

  if (matches.length === 1) {
    return matches[0]!;
  }

  if (matches.length > 1) {
    throw new MatchServiceError(
      'You have more than one in-progress match. Pass match_id to choose one.',
    );
  }

  if (hasMatchModeratorRole(interaction, config.matchModRoleId)) {
    throw new MatchServiceError('Provide match_id when using the match moderator role.');
  }

  throw new MatchServiceError('You have no in-progress match. Pass match_id to choose one.');
}

/**
 * Resolves a completed match for a mod correction command.
 * Requires guild, mod role, and the match to exist and be completed.
 */
async function resolveCompletedMatchForModCorrection(
  interaction: ChatInputCommandInteraction,
): Promise<MatchWithPlayers> {
  if (!interaction.guildId) {
    throw new MatchServiceError('This command can only be used in a server.');
  }

  const matchId = interaction.options.getString('match_id', true);
  const config = await resolveGuildConfig(interaction.guildId);

  assertHasMatchModRole({
    actorDiscordId: interaction.user.id,
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId: config.matchModRoleId,
  });

  const match = await getMatchById(matchId);
  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }

  if (match.status !== 'COMPLETED') {
    throw new MatchServiceError('This match is not completed.');
  }

  return match;
}

/** Mod-only lookup for clearing griefers/quitters on a finished match. */
async function resolveFinishedMatchForModClear(
  interaction: ChatInputCommandInteraction,
): Promise<MatchWithPlayers> {
  if (!interaction.guildId) {
    throw new MatchServiceError('This command can only be used in a server.');
  }

  const matchId = interaction.options.getString('match_id', true);
  const config = await resolveGuildConfig(interaction.guildId);

  assertHasMatchModRole({
    actorDiscordId: interaction.user.id,
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId: config.matchModRoleId,
  });

  const match = await getMatchById(matchId);
  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }

  if (match.status !== 'COMPLETED' && match.status !== 'CANCELLED') {
    throw new MatchServiceError('This match must be completed or cancelled.');
  }

  return match;
}

function formatClearedGriefersMessage(
  matchId: string,
  cleared: Array<{ slot: number; kiTaxRemoved: number }>,
): string {
  const lines = cleared.map((row) => `slot **${row.slot}** (−${row.kiTaxRemoved} ki from pool)`);
  return `Cleared griefer flag on match \`${matchId}\`: ${lines.join(', ')}.`;
}

function formatClearedQuittersMessage(
  matchId: string,
  cleared: ClearedMatchQuitter[],
  mode: 'ratings_restored' | 'flag_only',
  options: { flagOnlyReason?: string; hasNewerMatches?: boolean } = {},
): string {
  const slots = cleared.map((row) => row.slot).join(', ');
  const lines = [`Cleared quitter(s) on match \`${matchId}\`: slots ${slots}.`];

  if (mode === 'ratings_restored') {
    lines.push('Ratings were restored and re-applied.');
    if (options.hasNewerMatches) {
      lines.push(
        'Warning: some players have completed ranked matches since this one. Restoring ratings will overwrite their current ki; those later matches will not be re-applied.',
      );
    }
  } else {
    lines.push(
      `Ratings were not restored (${options.flagOnlyReason ?? 'ratings cannot be restored'}).`,
    );
  }

  return lines.join(' ');
}

function formatManualSanctionAddMessage(result: {
  matchId: string;
  username: string;
  type: ManualSanctionType;
  quits: number;
  griefs: number;
  grieferKiAccrued: number | null;
}): string {
  const label = result.type === 'quitter' ? 'quitter' : 'griefer';
  const lines = [
    `Manual ${label} sanction recorded for **${result.username}** (match \`${result.matchId}\`).`,
    `Quits: **${result.quits}** · Griefs: **${result.griefs}** (league).`,
  ];
  if (result.type === 'griefer' && result.grieferKiAccrued != null && result.grieferKiAccrued > 0) {
    lines.push(`Deferred ki tax: **${result.grieferKiAccrued}**.`);
  }
  return lines.join('\n');
}

function formatManualSanctionRemoveMessage(result: {
  matchId: string;
  username: string;
  type: ManualSanctionType;
  mode: 'manual_restored' | 'delegated_clear';
}): string {
  const label = result.type === 'quitter' ? 'quitter' : 'griefer';
  const restored =
    result.type === 'quitter' && result.mode === 'manual_restored' ? ' Ratings were restored.' : '';
  return `Removed manual ${label} sanction for **${result.username}** (match \`${result.matchId}\`).${restored}`;
}

async function assertMatchModInGuild(interaction: ChatInputCommandInteraction): Promise<void> {
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

async function resolveSanctionTargetPlayer(
  interaction: ChatInputCommandInteraction,
  leagueId: string,
): Promise<{ id: string; username: string }> {
  const discordUser = interaction.options.getUser('user');
  const lookup = parseRankOptions({
    selfDiscordId: interaction.user.id,
    userDiscordId: discordUser?.id,
    nick: interaction.options.getString('nick'),
  });

  if (lookup.kind === 'self') {
    throw new MatchServiceError('Provide a user or nick.');
  }
  if (lookup.kind === 'both') {
    throw new MatchServiceError('Provide either a Discord user or a nick, not both.');
  }

  const gameProfile = await getGameProfileForLeague(leagueId);
  const player = await ensurePlayerForModLookup(gameProfile.gameId, lookup, {
    discordUsername: discordUser ? (discordUser.globalName ?? discordUser.username) : null,
  });
  return { id: player.id, username: player.username };
}

async function applyMatchMutation(
  interaction: ChatInputCommandInteraction,
  match: MatchWithPlayers,
  mode: 'started' | 'completed' | 'cancelled',
  replyMessage: string,
  options: { ratingPreview?: LobbyRatingPreview; postToMatchLog?: boolean } = {},
): Promise<void> {
  await syncLobbyDiscordMessage(interaction.client, match, mode, options);
  await interaction.editReply({ content: replyMessage });
}

async function replyMatchRead(
  interaction: ChatInputCommandInteraction,
  payload: Pick<InteractionReplyOptions, 'content' | 'embeds' | 'components'>,
  ephemeral = false,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
    return;
  }
  await interaction.reply({
    ...payload,
    ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  });
}

function publicReadErrorMessage(subcommand: string): string {
  if (subcommand === 'show') {
    return 'Something went wrong loading that match.';
  }
  if (subcommand === 'list') {
    return 'Something went wrong loading the match list.';
  }
  return 'Something went wrong loading match history.';
}

export const data = new SlashCommandBuilder()
  .setName('match')
  .setDescription('Manage matches or view history')
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('history')
        .setDescription('List your completed matches (newest first)')
        .addUserOption((option) =>
          option.setName('user').setDescription('Discord user to look up').setRequired(false),
        )
        .addStringOption((option) =>
          option.setName('nick').setDescription('In-game nick to look up').setRequired(false),
        )
        .addIntegerOption((option) =>
          option.setName('page').setDescription('Page number').setRequired(false).setMinValue(1),
        )
        .addBooleanOption((option) =>
          option
            .setName('griefers_only')
            .setDescription(
              'Only show matches where this player was marked a griefer (includes cancelled)',
            )
            .setRequired(false),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('list')
        .setDescription('List completed matches in this league (newest first)')
        .addIntegerOption((option) =>
          option.setName('page').setDescription('Page number').setRequired(false).setMinValue(1),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('show')
        .setDescription('Show a completed match by id')
        .addStringOption((option) =>
          option.setName('match_id').setDescription('Completed match id').setRequired(true),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('quitters')
      .setDescription('Mark players who quit')
      .addStringOption((option) =>
        option
          .setName('slots')
          .setDescription('Comma-separated slots like "1,3,7"')
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('In-progress match id (required if you have more than one)')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('griefers')
      .setDescription('Mark players who abused a bug (host or mod)')
      .addStringOption((option) =>
        option
          .setName('slots')
          .setDescription('Comma-separated slots like "1,3,7"')
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('In-progress match id (required if you have more than one)')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('complete')
      .setDescription('Complete a match and apply ratings')
      .addStringOption((option) =>
        option
          .setName('winner')
          .setDescription('Winning team')
          .setRequired(true)
          .addChoices(
            { name: teamDisplayName(1), value: 'A' },
            { name: teamDisplayName(2), value: 'B' },
          ),
      )
      .addStringOption((option) =>
        option
          .setName('quitters')
          .setDescription('Comma-separated slots like "1,3,7"')
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('griefers')
          .setDescription('Comma-separated griefer slots like "2,8" (bug abuse penalty)')
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('In-progress match id (required if you have more than one)')
          .setRequired(false),
      )
      .addIntegerOption((option) =>
        option
          .setName('mitigation')
          .setDescription(
            'Soft result: reduce both teams’ ki Δ (mods apply immediately; hosts need approval)',
          )
          .setRequired(false)
          .addChoices(
            { name: 'None (full strength)', value: 0 },
            { name: '25%', value: 25 },
            { name: '35%', value: 35 },
            { name: '50%', value: 50 },
          ),
      )
      .addAttachmentOption((option) =>
        option.setName('report').setDescription('WOS bot match report (.txt)').setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('upload_report')
      .setDescription('Upload a WOS bot match stats report for an in-progress match')
      .addAttachmentOption((option) =>
        option.setName('report').setDescription('WOS bot match report (.txt)').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('In-progress match id (required if you have more than one)')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('cancel')
      .setDescription('Cancel an in-progress match')
      .addStringOption((option) =>
        option
          .setName('griefers')
          .setDescription('Comma-separated griefer slots like "2,8" (bug abuse penalty)')
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('In-progress match id (required if you have more than one)')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('flip')
      .setDescription('Correct the winner of a completed match (mods only, 24h)')
      .addStringOption((option) =>
        option.setName('match_id').setDescription('Completed match id').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('winner')
          .setDescription('Correct winning team')
          .setRequired(true)
          .addChoices(
            { name: teamDisplayName(1), value: 'A' },
            { name: teamDisplayName(2), value: 'B' },
          ),
      )
      .addStringOption((option) =>
        option
          .setName('quitters')
          .setDescription('Comma-separated slots; omit to keep current quitters')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('void')
      .setDescription('Void a completed match and restore ratings (mods only, 24h)')
      .addStringOption((option) =>
        option.setName('match_id').setDescription('Completed match id').setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('ungrief')
      .setDescription('Clear griefer flags and remove deferred ki tax (mods only)')
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('Completed or cancelled match id')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('slots')
          .setDescription('Comma-separated slots to clear; omit to clear all griefers on the match')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('unquit')
      .setDescription(
        'Clear quitter flags on a finished match; restore ratings when possible (mods only)',
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('Completed or cancelled match id')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('slots')
          .setDescription('Comma-separated slots to clear; omit to clear all quitters on the match')
          .setRequired(false),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('sanction')
      .setDescription('Add or remove quitter/griefer markers without a match (mods only)')
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('add')
            .setDescription('Record one quitter or griefer incident (mods only)')
            .addStringOption((option) =>
              option
                .setName('type')
                .setDescription('Sanction type')
                .setRequired(true)
                .addChoices(
                  { name: 'Quitter', value: 'quitter' },
                  { name: 'Griefer', value: 'griefer' },
                ),
            )
            .addUserOption((option) =>
              option.setName('user').setDescription('Discord user').setRequired(false),
            )
            .addStringOption((option) =>
              option.setName('nick').setDescription('In-game nick').setRequired(false),
            ),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('remove')
            .setDescription('Remove one quitter or griefer marker (mods only)')
            .addStringOption((option) =>
              option
                .setName('type')
                .setDescription('Sanction type')
                .setRequired(true)
                .addChoices(
                  { name: 'Quitter', value: 'quitter' },
                  { name: 'Griefer', value: 'griefer' },
                ),
            )
            .addUserOption((option) =>
              option.setName('user').setDescription('Discord user').setRequired(false),
            )
            .addStringOption((option) =>
              option.setName('nick').setDescription('In-game nick').setRequired(false),
            )
            .addStringOption((option) =>
              option
                .setName('match_id')
                .setDescription('Specific match id; omit to remove latest manual sanction')
                .setRequired(false),
            ),
        ),
      ),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondAllLeagueAutocomplete(interaction);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(true);
  const isPublicRead = subcommand === 'history' || subcommand === 'show' || subcommand === 'list';

  const historyLookup =
    subcommand === 'history'
      ? parseRankOptions({
          selfDiscordId: interaction.user.id,
          userDiscordId: interaction.options.getUser('user')?.id,
          nick: interaction.options.getString('nick'),
        })
      : null;

  // Self-unlinked history must stay private; Discord locks visibility on the first response.
  if (subcommand === 'history' && historyLookup?.kind !== 'self') {
    await interaction.deferReply();
  } else if (subcommand === 'show' || subcommand === 'list') {
    await interaction.deferReply();
  } else if (subcommand !== 'history') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const matchId = interaction.options.getString('match_id');

  log.info(
    {
      userId: interaction.user.id,
      subcommand,
      matchId,
      channelId: interaction.channelId,
    },
    'Match command started',
  );

  try {
    if (subcommand === 'history') {
      if (!interaction.guildId) {
        throw new MatchServiceError('This command can only be used in a server.');
      }
      const resolved = await resolveLeagueIdFromInteraction(
        interaction,
        getLeagueOption(interaction),
      );
      if (!resolved.ok) {
        await replyMatchRead(
          interaction,
          { content: resolved.message },
          historyLookup?.kind === 'self' && !interaction.deferred,
        );
        return;
      }

      const gameProfile = await getGameProfileForLeague(resolved.leagueId);
      const player = await resolveHistoryPlayer(gameProfile.gameId, historyLookup!);

      if (!interaction.deferred) {
        await interaction.deferReply();
      }

      const pageNum = interaction.options.getInteger('page') ?? 1;
      const griefersOnly = interaction.options.getBoolean('griefers_only') === true;
      const pageData = await loadMatchHistoryPage({
        leagueId: resolved.leagueId,
        playerId: player.id,
        username: player.username,
        page: pageNum,
        griefersOnly,
      });
      const embed = buildMatchHistoryEmbed(
        pageData,
        resolved.leagueId,
        (team) => teamDisplayName(team, gameProfile),
        { showTeam: gameProfile.matchHistoryShowsTeam },
      );
      const components = buildMatchHistoryPageButtons({
        invokerId: interaction.user.id,
        playerId: player.id,
        leagueId: resolved.leagueId,
        page: pageData.page,
        totalPages: pageData.totalPages,
        griefersOnly: pageData.griefersOnly,
      });
      await replyMatchRead(interaction, { embeds: [embed], components });
      return;
    }

    if (subcommand === 'list') {
      if (!interaction.guildId) {
        throw new MatchServiceError('This command can only be used in a server.');
      }
      const resolved = await resolveLeagueIdFromInteraction(
        interaction,
        getLeagueOption(interaction),
      );
      if (!resolved.ok) {
        await replyMatchRead(interaction, { content: resolved.message });
        return;
      }

      const gameProfile = await getGameProfileForLeague(resolved.leagueId);
      const pageNum = interaction.options.getInteger('page') ?? 1;
      const pageData = await loadMatchListPage({
        leagueId: resolved.leagueId,
        page: pageNum,
      });
      const embed = buildMatchListEmbed(pageData, (team) => teamDisplayName(team, gameProfile));
      const components = buildMatchListPageButtons({
        invokerId: interaction.user.id,
        leagueId: resolved.leagueId,
        page: pageData.page,
        totalPages: pageData.totalPages,
      });
      await replyMatchRead(interaction, { embeds: [embed], components });
      return;
    }

    if (subcommand === 'show') {
      if (!interaction.guildId) {
        throw new MatchServiceError('This command can only be used in a server.');
      }
      const showMatchId = interaction.options.getString('match_id', true);
      const leagueOpt = getLeagueOption(interaction);
      let leagueId: string | null = null;
      if (leagueOpt) {
        const resolved = await resolveLeagueIdFromInteraction(interaction, leagueOpt);
        if (!resolved.ok) {
          await interaction.editReply({ content: resolved.message });
          return;
        }
        leagueId = resolved.leagueId;
      }
      const { embed } = await loadCompletedMatchShow({
        matchId: showMatchId,
        guildId: interaction.guildId,
        leagueId,
      });
      await replyMatchRead(interaction, { embeds: [embed] });
      return;
    }

    if (subcommand === 'flip' || subcommand === 'void') {
      const match = await resolveCompletedMatchForModCorrection(interaction);
      const preview = await previewMatchCorrection(match.id);

      if (!preview.canCorrect) {
        await interaction.editReply({
          content: preview.correctionBlockReason ?? 'This match cannot be corrected.',
        });
        return;
      }

      const lines: string[] = [];

      if (subcommand === 'flip') {
        const winner = parseWinner(interaction.options.getString('winner', true));
        const quittersRaw = interaction.options.getString('quitters');
        const quitterSlots = quittersRaw === null ? undefined : parseQuitterSlots(quittersRaw);
        const quittersLine =
          quitterSlots !== undefined && quitterSlots.length > 0
            ? ` with quitters [${quitterSlots.join(', ')}]`
            : '';

        const profile = await getGameProfileForMatch(match);
        lines.push(
          `Flip match \`${match.id}\` → winner **${winnerLabel(winner, profile)}**${quittersLine}.`,
        );
        if (preview.hasNewerMatches) {
          lines.push(
            'Warning: some players have completed ranked matches since this one. Restoring ratings will overwrite their current ki; those later matches will not be re-applied.',
          );
        }
        lines.push('This can only be done within 24 hours of completion.');

        await interaction.editReply({
          content: lines.join('\n'),
          components: buildMatchCorrectionConfirmComponents({
            action: 'flip',
            matchId: match.id,
            actorDiscordId: interaction.user.id,
            winningTeam: winner,
            quitterSlots: quitterSlots ?? quitterSlotsFromPlayers(match.players),
          }),
        });
      } else {
        lines.push(
          `Void match \`${match.id}\`. Ratings will be restored to pre-match values and the match will be cancelled.`,
        );
        if (preview.hasNewerMatches) {
          lines.push(
            'Warning: some players have completed ranked matches since this one. Restoring ratings will overwrite their current ki; those later matches will not be re-applied.',
          );
        }
        lines.push('This can only be done within 24 hours of completion.');

        await interaction.editReply({
          content: lines.join('\n'),
          components: buildMatchCorrectionConfirmComponents({
            action: 'void',
            matchId: match.id,
            actorDiscordId: interaction.user.id,
          }),
        });
      }

      return;
    }

    if (subcommand === 'ungrief') {
      await resolveFinishedMatchForModClear(interaction);
      const matchId = interaction.options.getString('match_id', true);
      const slotsRaw = interaction.options.getString('slots');
      const slots = slotsRaw === null ? undefined : parseGrieferSlots(slotsRaw);

      await interaction.editReply({ content: 'Clearing griefer flags…' });
      const { match, cleared } = await clearMatchGriefers(matchId, slots);

      if (interaction.guildId) {
        await refreshGuildGrieferLeaderboard(interaction.client, interaction.guildId);
      }
      await refreshLeagueLeaderboard(interaction.client, requireLeagueId(match));

      await interaction.editReply({
        content: formatClearedGriefersMessage(match.id, cleared),
      });
      return;
    }

    if (subcommand === 'unquit') {
      await resolveFinishedMatchForModClear(interaction);
      const matchId = interaction.options.getString('match_id', true);
      const slotsRaw = interaction.options.getString('slots');
      const slots = slotsRaw === null ? undefined : parseQuitterSlots(slotsRaw);

      await interaction.editReply({ content: 'Clearing quitter flags…' });
      const result = await clearMatchQuitters(matchId, slots);

      const syncMode = result.match.status === 'COMPLETED' ? 'completed' : 'cancelled';
      await syncLobbyDiscordMessage(interaction.client, result.match, syncMode, {
        ratingPreview: result.ratingPreview,
      });

      if (interaction.guildId) {
        await refreshGuildQuitterLeaderboard(interaction.client, interaction.guildId);
      }
      await refreshLeagueLeaderboard(interaction.client, requireLeagueId(result.match));

      await interaction.editReply({
        content: formatClearedQuittersMessage(result.match.id, result.cleared, result.mode, {
          flagOnlyReason: result.flagOnlyReason,
          hasNewerMatches: result.hasNewerMatches,
        }),
      });
      return;
    }

    if (subcommandGroup === 'sanction') {
      await assertMatchModInGuild(interaction);

      const resolved = await resolveLeagueIdFromInteraction(
        interaction,
        getLeagueOption(interaction),
      );
      if (!resolved.ok) {
        await interaction.editReply({ content: resolved.message });
        return;
      }

      const player = await resolveSanctionTargetPlayer(interaction, resolved.leagueId);
      const type = interaction.options.getString('type', true);
      if (type !== 'quitter' && type !== 'griefer') {
        throw new MatchServiceError('Invalid sanction type.');
      }

      if (subcommand === 'add') {
        if (!interaction.channelId) {
          throw new MatchServiceError('This command can only be used in a channel.');
        }

        await interaction.editReply({ content: 'Recording sanction…' });
        const result = await addManualSanction({
          leagueId: resolved.leagueId,
          playerId: player.id,
          type,
          actorDiscordId: interaction.user.id,
          discordChannelId: interaction.channelId,
        });

        if (interaction.guildId) {
          await refreshGuildQuitterLeaderboard(interaction.client, interaction.guildId);
          await refreshGuildGrieferLeaderboard(interaction.client, interaction.guildId);
        }

        await interaction.editReply({ content: formatManualSanctionAddMessage(result) });
        return;
      }

      if (subcommand === 'remove') {
        const matchIdOption = interaction.options.getString('match_id');

        await interaction.editReply({ content: 'Removing sanction…' });
        const result = await removeManualSanction({
          leagueId: resolved.leagueId,
          playerId: player.id,
          username: player.username,
          type,
          matchId: matchIdOption ?? undefined,
        });

        if (interaction.guildId) {
          await refreshGuildQuitterLeaderboard(interaction.client, interaction.guildId);
          await refreshGuildGrieferLeaderboard(interaction.client, interaction.guildId);
        }

        await interaction.editReply({ content: formatManualSanctionRemoveMessage(result) });
        return;
      }
    }

    const match = await resolveMatchForCommand(interaction, matchId);
    const guildConfig =
      interaction.guildId !== null ? await resolveGuildConfig(interaction.guildId) : null;

    if (subcommand === 'quitters') {
      const quitterSlots = parseQuitterSlots(interaction.options.getString('slots'));
      await interaction.editReply({ content: 'Saving quitters…' });
      const updated = await setQuitters(match.id, quitterSlots);
      await applyMatchMutation(
        interaction,
        updated,
        'started',
        `Quitters updated in match \`${updated.id}\`.`,
      );
      return;
    }

    if (subcommand === 'griefers') {
      const grieferSlots = parseGrieferSlots(interaction.options.getString('slots'));
      await interaction.editReply({ content: 'Saving griefers…' });
      const updated = await setGriefers(match.id, grieferSlots);
      await applyMatchMutation(
        interaction,
        updated,
        'started',
        `Griefers updated in match \`${updated.id}\`.`,
      );
      return;
    }

    if (subcommand === 'upload_report') {
      const attachment = interaction.options.getAttachment('report', true);
      if (!isTextReportAttachment(attachment)) {
        throw new MatchServiceError('Please attach a .txt match report file.');
      }

      await interaction.editReply({ content: 'Uploading match stats…' });
      const rawText = await fetchTextAttachment(attachment.url);
      const result = await uploadMatchStatsReport({
        matchId: match.id,
        actorDiscordId: interaction.user.id,
        memberRoleIds: memberRoleIds(interaction),
        matchModRoleId: guildConfig?.matchModRoleId,
        rawText,
      });

      const lines = [
        `Match stats saved for \`${result.matchId}\` (report id \`${result.externalId}\`).`,
        ...result.summaryLines.map((line) => `- ${line}`),
      ];
      if (result.warnings.length > 0) {
        lines.push('', ...result.warnings.map((warning) => `⚠ ${warning}`));
      }

      await interaction.editReply({ content: lines.join('\n') });
      return;
    }

    if (subcommand === 'complete') {
      const winner = parseWinner(interaction.options.getString('winner', true));
      const quittersRaw = interaction.options.getString('quitters');
      const quitterSlots = quittersRaw === null ? undefined : parseQuitterSlots(quittersRaw);
      const griefersRaw = interaction.options.getString('griefers');
      const grieferSlots = griefersRaw === null ? undefined : parseGrieferSlots(griefersRaw);
      const reportAttachment = interaction.options.getAttachment('report');
      const mitigation = normalizeMitigationPercent(
        interaction.options.getInteger('mitigation') ?? 0,
      );

      await interaction.editReply({
        content: 'Updating ratings and completing the match… This can take a few seconds.',
      });

      if (reportAttachment) {
        if (!isTextReportAttachment(reportAttachment)) {
          throw new MatchServiceError('Please attach a .txt match report file.');
        }
        const rawText = await fetchTextAttachment(reportAttachment.url);
        await uploadMatchStatsReport({
          matchId: match.id,
          actorDiscordId: interaction.user.id,
          memberRoleIds: memberRoleIds(interaction),
          matchModRoleId: guildConfig?.matchModRoleId,
          rawText,
        });
      }

      const profile = await getGameProfileForMatch(match);
      if (profile.postMatchStats === 'wos2_bot_v1' && !(await hasMatchStatsReport(match.id))) {
        throw new MatchServiceError(WOS_MATCH_REPORT_REQUIRED_MESSAGE);
      }

      const isMod = hasMatchModeratorRole(interaction, guildConfig?.matchModRoleId);
      if (!isMod && mitigation > 0) {
        const resolvedQuitters =
          quitterSlots ?? match.players.filter((p) => p.isQuitter).map((p) => p.slot);
        const resolvedGriefers =
          grieferSlots ?? match.players.filter((p) => p.isGriefer).map((p) => p.slot);
        await requestMitigationApproval({
          matchId: match.id,
          winningTeam: winner,
          quitterSlots: resolvedQuitters,
          grieferSlots: resolvedGriefers,
          mitigationPercent: mitigation as RatingMitigationPercent,
          client: interaction.client,
          requestedByTag: `<@${interaction.user.id}>`,
          winnerLabel: winnerLabel(winner, profile),
          quitterSummary:
            resolvedQuitters.length === 0
              ? 'Quitters: none'
              : `Quitters: ${resolvedQuitters.join(', ')}`,
          grieferSummary:
            resolvedGriefers.length === 0
              ? 'Griefers: none'
              : `Griefers: ${resolvedGriefers.join(', ')}`,
        });
        const pending = await getMatchById(match.id);
        if (pending) {
          await syncLobbyDiscordMessage(interaction.client, pending, 'started');
        }
        await interaction.editReply({
          content: [
            `Mitigation **${mitigation}%** requested for match \`${match.id}\`.`,
            'A moderator must **Approve** the request in this channel before ratings apply.',
          ].join('\n'),
        });
        return;
      }

      const completed = await completeMatch(
        match.id,
        winner,
        quitterSlots,
        grieferSlots,
        mitigation,
      );
      void refreshAllLeaderboardChannels(interaction.client).catch(() => undefined);

      const mitNote = mitigation > 0 ? ` Mitigation: **${mitigation}%**.` : '';
      const completionMessage = `Match \`${completed.match.id}\` completed. Winner: **${winnerLabel(winner, profile)}**.${mitNote}`;

      await applyMatchMutation(interaction, completed.match, 'completed', completionMessage, {
        ratingPreview: completed.ratingPreview,
        postToMatchLog: true,
      });
      return;
    }

    if (subcommand === 'cancel') {
      const griefersRaw = interaction.options.getString('griefers');
      const grieferSlots = griefersRaw === null ? undefined : parseGrieferSlots(griefersRaw);
      await interaction.editReply({
        content:
          'Cancelling the match… Applying quitter penalties and recording griefer season tax if any are marked.',
      });
      const cancelled = await cancelInProgressMatch(match.id, grieferSlots);
      await applyMatchMutation(
        interaction,
        cancelled,
        'cancelled',
        `Match \`${cancelled.id}\` cancelled.`,
      );
      return;
    }

    await interaction.editReply({ content: 'Unknown match subcommand.' });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      log.warn({ err: error, userId: interaction.user.id, subcommand }, 'Match command rejected');
      if (isPublicRead) {
        await replyMatchRead(
          interaction,
          { content: error.message },
          subcommand === 'history' && historyLookup?.kind === 'self' && !interaction.deferred,
        );
      } else {
        await interaction.editReply({ content: error.message });
      }
      return;
    }

    log.error({ err: error, userId: interaction.user.id, subcommand }, 'Match command failed');
    if (isPublicRead) {
      await replyMatchRead(
        interaction,
        { content: publicReadErrorMessage(subcommand) },
        subcommand === 'history' && historyLookup?.kind === 'self' && !interaction.deferred,
      );
      return;
    }
    await interaction.editReply({
      content: 'Could not update the match. Please try again.',
    });
  }
}
