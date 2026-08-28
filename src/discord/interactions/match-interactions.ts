import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  StringSelectMenuBuilder,
} from 'discord.js';
import type {
  ButtonInteraction,
  Interaction,
  MessageComponentInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import { sendReplacingEphemeral, touchEphemeralSession } from '../../lib/ephemeral-reply.js';
import { createLogger } from '../../lib/logger.js';
import {
  resolveInProgressMatchByMessageId,
  syncLobbyDiscordMessage,
} from '../../services/lobby/index.js';
import { refreshAllLeaderboardChannels } from '../../services/leaderboard/index.js';
import {
  cancelInProgressMatch,
  completeMatch,
  formatMatchStatsSummaryLines,
  getMatchById,
  getGameProfileForMatch,
  hasMatchStatsReport,
  loadMatchPlayerStatsLines,
  loadSuggestedWinnerForMatch,
  MatchServiceError,
  setGriefers,
  setQuitters,
  WOS_MATCH_REPORT_REQUIRED_MESSAGE,
  type MatchWithPlayers,
} from '../../services/match/index.js';
import { assertCanManageMatch } from '../../services/match/index.js';
import { assertTeam, type GameProfile } from '../../domain/game-profile.js';
import { resolveGuildConfig, winnerLabel } from '../../services/guild/index.js';
import {
  buildReportConfirmCustomId,
  buildReportQuitterSelectOptions,
  decodeReportSlots,
  encodeReportSlots,
} from './match-report-wizard.js';

const log = createLogger('match-interactions');

type MatchPlayer = MatchWithPlayers['players'][number];
type ComponentRow = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;

function parseCustomId(customId: string): string[] {
  return customId.split(':');
}

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

const encodeSlots = encodeReportSlots;
const decodeSlots = decodeReportSlots;

function sortedPlayers(match: MatchWithPlayers): MatchPlayer[] {
  return [...match.players].sort((a, b) => a.slot - b.slot);
}

function decodeTeam(teamRaw: string | undefined): 1 | 2 {
  if (teamRaw === '1' || teamRaw === '2') {
    return assertTeam(Number(teamRaw));
  }

  throw new MatchServiceError('Invalid winning team selection.');
}

function formatPlayer(player: MatchPlayer): string {
  return `Slot ${player.slot}: ${player.player.username}`;
}

function formatQuitterSummary(match: MatchWithPlayers, quitterSlots: number[]): string {
  const quitterSet = new Set(quitterSlots);
  const quitters = sortedPlayers(match).filter((player) => quitterSet.has(player.slot));

  if (quitters.length === 0) {
    return 'Quitters: none';
  }

  return `Quitters:\n${quitters.map((player) => `- ${formatPlayer(player)}`).join('\n')}`;
}

function formatGrieferSummary(match: MatchWithPlayers, grieferSlots: number[]): string {
  const grieferSet = new Set(grieferSlots);
  const griefers = sortedPlayers(match).filter((player) => grieferSet.has(player.slot));

  if (griefers.length === 0) {
    return 'Griefers: none';
  }

  return `Griefers:\n${griefers.map((player) => `- ${formatPlayer(player)}`).join('\n')}`;
}

/** Slots already flagged as quitters on the match (for select defaults / Continue). */
function preselectedQuitterSlots(match: MatchWithPlayers): number[] {
  return sortedPlayers(match)
    .filter((player) => player.isQuitter)
    .map((player) => player.slot);
}

function preselectedGrieferSlots(match: MatchWithPlayers): number[] {
  return sortedPlayers(match)
    .filter((player) => player.isGriefer)
    .map((player) => player.slot);
}

function buildQuitterSelectRow(
  match: MatchWithPlayers,
  customId: string,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = sortedPlayers(match).map((player) => ({
    label: formatPlayer(player).slice(0, 100),
    value: String(player.slot),
    default: player.isQuitter,
  }));

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Select players who quit')
      .setMinValues(0)
      .setMaxValues(options.length)
      .addOptions(options),
  );
}

/**
 * Discord does not fire a select interaction when the user leaves defaults unchanged.
 * When quitters are pre-selected, offer a button that continues with those slots.
 */
function buildQuitterContinueRow(
  matchId: string,
  quitterSlots: number[],
): ActionRowBuilder<ButtonBuilder> | null {
  if (quitterSlots.length === 0) {
    return null;
  }

  const slotsCsv = encodeSlots(quitterSlots);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:qok:${matchId}:${slotsCsv}`)
      .setLabel('Save selected')
      .setStyle(ButtonStyle.Primary),
  );
}

function buildReportGrieferSkipRow(matchId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:rw:gskip:${matchId}`)
      .setLabel('No Griefers')
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildReportGrieferContinueRow(
  matchId: string,
  grieferSlots: number[],
): ActionRowBuilder<ButtonBuilder> | null {
  if (grieferSlots.length === 0) {
    return null;
  }

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:rw:gok:${matchId}:${encodeSlots(grieferSlots)}`)
      .setLabel('Continue with selected')
      .setStyle(ButtonStyle.Primary),
  );
}

function buildQuitterSelectRowForReport(
  match: MatchWithPlayers,
  matchId: string,
  grieferSlots: number[],
): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const options = buildReportQuitterSelectOptions(match.players, grieferSlots);
  if (options.length === 0) {
    return null;
  }

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`match:rw:q:${matchId}:${encodeSlots(grieferSlots)}`)
      .setPlaceholder('Select players who quit')
      .setMinValues(0)
      .setMaxValues(options.length)
      .addOptions(options),
  );
}

function preselectedReportQuitterSlots(match: MatchWithPlayers, grieferSlots: number[]): number[] {
  const grieferSet = new Set(grieferSlots);
  return preselectedQuitterSlots(match).filter((slot) => !grieferSet.has(slot));
}

function reportQuitterStepHint(
  match: MatchWithPlayers,
  grieferSlots: number[],
  preselected: number[],
): string {
  const grieferLine = formatGrieferSummary(match, grieferSlots);
  const quitterHint =
    preselected.length > 0
      ? 'Select any players who quit (or Continue with selected), then choose the winner:'
      : 'Select any players who quit, then choose the winner:';
  return `${grieferLine}\n\n${quitterHint}`;
}

function reportQuitterStepComponents(
  match: MatchWithPlayers,
  grieferSlots: number[],
): ComponentRow[] {
  const preselected = preselectedReportQuitterSlots(match, grieferSlots);
  const components: ComponentRow[] = [];
  const selectRow = buildQuitterSelectRowForReport(match, match.id, grieferSlots);
  if (selectRow) {
    components.push(selectRow);
  }
  const continueRow = buildReportQuitterContinueRow(match.id, grieferSlots, preselected);
  if (continueRow) {
    components.push(continueRow);
  }
  components.push(buildReportQuitterSkipRow(match.id, grieferSlots));
  return components;
}

async function showReportQuitterStep(
  interaction: MessageComponentInteraction,
  match: MatchWithPlayers,
  grieferSlots: number[],
): Promise<void> {
  const preselected = preselectedReportQuitterSlots(match, grieferSlots);
  await updateEphemeral(
    interaction,
    reportQuitterStepHint(match, grieferSlots, preselected),
    reportQuitterStepComponents(match, grieferSlots),
  );
}

function buildSuggestedWinnerContinueRow(
  matchId: string,
  grieferSlots: number[],
  quitterSlots: number[],
  suggestedTeam: 1 | 2,
  profile: GameProfile,
): ActionRowBuilder<ButtonBuilder> {
  const grieferCsv = encodeSlots(grieferSlots);
  const quitterCsv = encodeSlots(quitterSlots);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:rw:win:${matchId}:${suggestedTeam}:${grieferCsv}:${quitterCsv}`)
      .setLabel(`Continue with ${winnerLabel(suggestedTeam, profile)}`)
      .setStyle(ButtonStyle.Success),
  );
}

async function showReportWinnerStep(
  interaction: MessageComponentInteraction,
  match: MatchWithPlayers,
  grieferSlots: number[],
  quitterSlots: number[],
): Promise<void> {
  const profile = await profileForMatch(match);
  const { suggested, roundLine } = await loadSuggestedWinnerForMatch(match.id);

  const lines = [
    formatGrieferSummary(match, grieferSlots),
    formatQuitterSummary(match, quitterSlots),
    '',
  ];

  if (suggested) {
    const roundSuffix = roundLine ? ` (${roundLine})` : '';
    lines.push(
      `Report suggests **${winnerLabel(suggested.team, profile)}** won${roundSuffix}.`,
      '',
      'Continue with the suggested winner or pick another team:',
    );
  } else {
    lines.push('Choose the winner:');
  }

  const components: ComponentRow[] = [];
  if (suggested) {
    components.push(
      buildSuggestedWinnerContinueRow(
        match.id,
        grieferSlots,
        quitterSlots,
        suggested.team,
        profile,
      ),
    );
  }
  components.push(buildWinnerRow(match.id, grieferSlots, quitterSlots, profile));

  await updateEphemeral(interaction, lines.join('\n'), components);
}

function buildReportQuitterSkipRow(
  matchId: string,
  grieferSlots: number[],
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:rw:qskip:${matchId}:${encodeSlots(grieferSlots)}`)
      .setLabel('No Quitters')
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildReportQuitterContinueRow(
  matchId: string,
  grieferSlots: number[],
  quitterSlots: number[],
): ActionRowBuilder<ButtonBuilder> | null {
  if (quitterSlots.length === 0) {
    return null;
  }

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        `match:rw:qok:${matchId}:${encodeSlots(grieferSlots)}:${encodeSlots(quitterSlots)}`,
      )
      .setLabel('Continue with selected')
      .setStyle(ButtonStyle.Primary),
  );
}

function buildGrieferSelectRow(
  match: MatchWithPlayers,
  customId: string,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = sortedPlayers(match).map((player) => ({
    label: formatPlayer(player).slice(0, 100),
    value: String(player.slot),
    default: player.isGriefer,
  }));

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Select griefers (bug abuse)')
      .setMinValues(0)
      .setMaxValues(options.length)
      .addOptions(options),
  );
}

function buildGrieferContinueRow(
  matchId: string,
  grieferSlots: number[],
): ActionRowBuilder<ButtonBuilder> | null {
  if (grieferSlots.length === 0) {
    return null;
  }

  const slotsCsv = encodeSlots(grieferSlots);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:gok:${matchId}:${slotsCsv}`)
      .setLabel('Save selected')
      .setStyle(ButtonStyle.Primary),
  );
}

function buildWinnerRow(
  matchId: string,
  grieferSlots: number[],
  quitterSlots: number[],
  profile: GameProfile,
): ActionRowBuilder<ButtonBuilder> {
  const grieferCsv = encodeSlots(grieferSlots);
  const quitterCsv = encodeSlots(quitterSlots);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:rw:win:${matchId}:1:${grieferCsv}:${quitterCsv}`)
      .setLabel(`${winnerLabel(1, profile)} Won`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`match:rw:win:${matchId}:2:${grieferCsv}:${quitterCsv}`)
      .setLabel(`${winnerLabel(2, profile)} Won`)
      .setStyle(ButtonStyle.Primary),
  );
}

function buildConfirmRow(
  matchId: string,
  winningTeam: 1 | 2,
  grieferSlots: number[],
  quitterSlots: number[],
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildReportConfirmCustomId(matchId, winningTeam, grieferSlots, quitterSlots))
      .setLabel('Confirm Result')
      .setStyle(ButtonStyle.Success),
  );
}

function buildReportStatsRefreshRow(
  matchId: string,
  winningTeam: 1 | 2,
  grieferSlots: number[],
  quitterSlots: number[],
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        `match:rw:statrefresh:${matchId}:${winningTeam}:${encodeSlots(grieferSlots)}:${encodeSlots(quitterSlots)}`,
      )
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Primary),
  );
}

async function showReportConfirmStep(
  interaction: MessageComponentInteraction,
  match: MatchWithPlayers,
  winningTeam: 1 | 2,
  grieferSlots: number[],
  quitterSlots: number[],
): Promise<void> {
  const profile = await profileForMatch(match);
  const content = [
    `Winner: **${winnerLabel(winningTeam, profile)}**`,
    formatGrieferSummary(match, grieferSlots),
    formatQuitterSummary(match, quitterSlots),
    '',
    'Confirm to complete the match and apply ratings.',
  ].join('\n');

  await updateEphemeral(interaction, content, [
    buildConfirmRow(match.id, winningTeam, grieferSlots, quitterSlots),
  ]);
}

async function showReportStatsStep(
  interaction: MessageComponentInteraction,
  match: MatchWithPlayers,
  winningTeam: 1 | 2,
  grieferSlots: number[],
  quitterSlots: number[],
): Promise<void> {
  const profile = await profileForMatch(match);
  const hasReport = await hasMatchStatsReport(match.id);
  const lines = [
    `Winner: **${winnerLabel(winningTeam, profile)}**`,
    formatGrieferSummary(match, grieferSlots),
    formatQuitterSummary(match, quitterSlots),
    '',
  ];

  const components: ComponentRow[] = [];

  if (hasReport) {
    const stats = await loadMatchPlayerStatsLines(match.id);
    lines.push(
      '**Match stats**',
      ...formatMatchStatsSummaryLines(stats),
      '',
      'Confirm to complete the match.',
    );
    components.push(buildConfirmRow(match.id, winningTeam, grieferSlots, quitterSlots));
  } else {
    lines.push(
      'Upload the WOS bot match `.txt` report with `/match upload_report`, then tap **Refresh**.',
      'A match report is required before this match can be completed.',
    );
    components.push(buildReportStatsRefreshRow(match.id, winningTeam, grieferSlots, quitterSlots));
  }

  await updateEphemeral(interaction, lines.join('\n'), components);
}

function buildCancelGrieferSkipRow(matchId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:cancel:skip:${matchId}`)
      .setLabel('No Griefers')
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildCancelGrieferContinueRow(
  matchId: string,
  grieferSlots: number[],
): ActionRowBuilder<ButtonBuilder> | null {
  if (grieferSlots.length === 0) {
    return null;
  }

  const slotsCsv = encodeSlots(grieferSlots);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:cancel:gok:${matchId}:${slotsCsv}`)
      .setLabel('Continue with selected')
      .setStyle(ButtonStyle.Primary),
  );
}

function buildCancelConfirmRow(
  matchId: string,
  grieferSlots: number[],
): ActionRowBuilder<ButtonBuilder> {
  const slotsCsv = encodeSlots(grieferSlots);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:cancel:ok:${matchId}:${slotsCsv}`)
      .setLabel('Cancel Match')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`match:cancel:no:${matchId}`)
      .setLabel('Keep Match')
      .setStyle(ButtonStyle.Secondary),
  );
}

async function replyEphemeral(
  interaction: MessageComponentInteraction,
  content: string,
  components: ComponentRow[] = [],
): Promise<void> {
  await sendReplacingEphemeral(interaction, { content, components });
}

async function updateEphemeral(
  interaction: MessageComponentInteraction,
  content: string,
  components: ComponentRow[] = [],
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content, components });
    touchEphemeralSession(interaction);
    return;
  }

  await interaction.update({ content, components });
  touchEphemeralSession(interaction);
}

async function resolveByMessage(
  interaction: MessageComponentInteraction,
): Promise<MatchWithPlayers> {
  if (!interaction.guildId) {
    throw new MatchServiceError('This action can only be used in a server.');
  }

  const config = await resolveGuildConfig(interaction.guildId);

  return resolveInProgressMatchByMessageId({
    messageId: interaction.message.id,
    actorDiscordId: interaction.user.id,
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId: config.matchModRoleId,
  });
}

async function resolveById(
  interaction: MessageComponentInteraction,
  matchId: string,
): Promise<MatchWithPlayers> {
  const match = await getMatchById(matchId);

  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }

  if (match.status !== 'IN_PROGRESS') {
    throw new MatchServiceError('This match is not in progress.');
  }

  if (!interaction.guildId) {
    throw new MatchServiceError('This action can only be used in a server.');
  }

  const config = await resolveGuildConfig(interaction.guildId);

  assertCanManageMatch({
    hostDiscordId: match.hostDiscordId,
    actorDiscordId: interaction.user.id,
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId: config.matchModRoleId,
  });

  return match;
}

async function profileForMatch(match: MatchWithPlayers): Promise<GameProfile> {
  return getGameProfileForMatch(match);
}

/**
 * Show a processing state on the ephemeral wizard (clear buttons) before slow work.
 * After this, use editReply for the final result.
 */
async function showWorking(
  interaction: MessageComponentInteraction,
  content: string,
): Promise<void> {
  await updateEphemeral(interaction, content, []);
}

async function safeHandle(
  interaction: MessageComponentInteraction,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof MatchServiceError) {
      log.warn(
        { err: error, customId: interaction.customId, userId: interaction.user.id },
        'Match interaction rejected',
      );

      // Prefer replacing the "working…" message when the interaction was already updated.
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: error.message, components: [] });
        return;
      }

      await replyEphemeral(interaction, error.message);
      return;
    }

    throw error;
  }
}

async function handleReportEntry(interaction: ButtonInteraction): Promise<void> {
  const match = await resolveByMessage(interaction);

  if (match.players.length === 0) {
    throw new MatchServiceError('This match has no players to report.');
  }

  const preselected = preselectedGrieferSlots(match);
  const components: ComponentRow[] = [buildGrieferSelectRow(match, `match:rw:g:${match.id}`)];
  const continueRow = buildReportGrieferContinueRow(match.id, preselected);
  if (continueRow) {
    components.push(continueRow);
  }
  components.push(buildReportGrieferSkipRow(match.id));

  const hint =
    preselected.length > 0
      ? 'Select any griefers (bug abuse), or Continue with selected, then quitters and winner:'
      : 'Select any griefers (bug abuse), then quitters and winner:';

  await replyEphemeral(interaction, hint, components);
}

async function handleQuittersEntry(interaction: ButtonInteraction): Promise<void> {
  const match = await resolveByMessage(interaction);

  if (match.players.length === 0) {
    throw new MatchServiceError('This match has no players to update.');
  }

  const preselected = preselectedQuitterSlots(match);
  const components: ComponentRow[] = [buildQuitterSelectRow(match, `match:qset:${match.id}`)];
  const continueRow = buildQuitterContinueRow(match.id, preselected);
  if (continueRow) {
    components.push(continueRow);
  }

  const hint =
    preselected.length > 0
      ? 'Select players who quit, or Save selected to keep the current flags:'
      : 'Select players who quit:';

  await replyEphemeral(interaction, hint, components);
}

async function handleGriefersEntry(interaction: ButtonInteraction): Promise<void> {
  const match = await resolveByMessage(interaction);

  if (match.players.length === 0) {
    throw new MatchServiceError('This match has no players to update.');
  }

  const preselected = preselectedGrieferSlots(match);
  const components: ComponentRow[] = [buildGrieferSelectRow(match, `match:gset:${match.id}`)];
  const continueRow = buildGrieferContinueRow(match.id, preselected);
  if (continueRow) {
    components.push(continueRow);
  }

  const hint =
    preselected.length > 0
      ? 'Select griefers (bug abuse), or Save selected to keep the current flags:'
      : 'Select players who abused a bug to cancel the match:';

  await replyEphemeral(interaction, hint, components);
}

async function handleCancelEntry(interaction: ButtonInteraction): Promise<void> {
  const match = await resolveByMessage(interaction);

  if (match.players.length === 0) {
    throw new MatchServiceError('This match has no players to cancel.');
  }

  const preselected = preselectedGrieferSlots(match);
  const components: ComponentRow[] = [
    buildGrieferSelectRow(match, `match:cancel:gset:${match.id}`),
  ];
  const continueRow = buildCancelGrieferContinueRow(match.id, preselected);
  if (continueRow) {
    components.push(continueRow);
  }
  components.push(buildCancelGrieferSkipRow(match.id));

  const hint =
    preselected.length > 0
      ? 'Select any griefers (bug abuse), or Continue with selected, then confirm cancel:'
      : 'Select any griefers (bug abuse), then confirm cancel:';

  await replyEphemeral(interaction, hint, components);
}

async function handleCancelGriefers(
  interaction: StringSelectMenuInteraction,
  matchId: string,
): Promise<void> {
  const match = await resolveById(interaction, matchId);
  const grieferSlots = interaction.values.map((slot) => Number(slot));

  await updateEphemeral(
    interaction,
    [
      `Cancel match \`${matchId}\`?`,
      formatGrieferSummary(match, grieferSlots),
      '',
      'Griefers accrue season-end ki tax (25%, max 500 ki per incident).',
    ].join('\n'),
    [buildCancelConfirmRow(matchId, grieferSlots)],
  );
}

async function handleCancelGriefersKeep(
  interaction: ButtonInteraction,
  matchId: string,
  grieferSlots: number[],
): Promise<void> {
  const match = await resolveById(interaction, matchId);

  await updateEphemeral(
    interaction,
    [
      `Cancel match \`${matchId}\`?`,
      formatGrieferSummary(match, grieferSlots),
      '',
      'Griefers accrue season-end ki tax (25%, max 500 ki per incident).',
    ].join('\n'),
    [buildCancelConfirmRow(matchId, grieferSlots)],
  );
}

async function handleCancelSkip(interaction: ButtonInteraction, matchId: string): Promise<void> {
  const match = await resolveById(interaction, matchId);

  await updateEphemeral(
    interaction,
    [
      `Cancel match \`${matchId}\`?`,
      'Griefers: none',
      '',
      'Quitter penalties still apply if any are marked.',
    ].join('\n'),
    [buildCancelConfirmRow(matchId, [])],
  );
}

async function handleReportGriefers(
  interaction: StringSelectMenuInteraction,
  matchId: string,
): Promise<void> {
  const match = await resolveById(interaction, matchId);
  const grieferSlots = interaction.values.map((slot) => Number(slot));
  await showReportQuitterStep(interaction, match, grieferSlots);
}

async function handleReportGriefersKeep(
  interaction: ButtonInteraction,
  matchId: string,
  grieferSlots: number[],
): Promise<void> {
  const match = await resolveById(interaction, matchId);
  await showReportQuitterStep(interaction, match, grieferSlots);
}

async function handleReportGrieferSkip(
  interaction: ButtonInteraction,
  matchId: string,
): Promise<void> {
  const match = await resolveById(interaction, matchId);
  await showReportQuitterStep(interaction, match, []);
}

async function handleReportQuitters(
  interaction: StringSelectMenuInteraction,
  matchId: string,
  grieferSlots: number[],
): Promise<void> {
  const match = await resolveById(interaction, matchId);
  const quitterSlots = interaction.values.map((slot) => Number(slot));
  await showReportWinnerStep(interaction, match, grieferSlots, quitterSlots);
}

/** Continue Report Winner with pre-selected quitters (select unchanged). */
async function handleReportQuittersKeep(
  interaction: ButtonInteraction,
  matchId: string,
  grieferSlots: number[],
  quitterSlots: number[],
): Promise<void> {
  const match = await resolveById(interaction, matchId);
  await showReportWinnerStep(interaction, match, grieferSlots, quitterSlots);
}

async function handleReportQuitterSkip(
  interaction: ButtonInteraction,
  matchId: string,
  grieferSlots: number[],
): Promise<void> {
  const match = await resolveById(interaction, matchId);
  await showReportWinnerStep(interaction, match, grieferSlots, []);
}

async function handleWinnerChoice(
  interaction: ButtonInteraction,
  matchId: string,
  winningTeam: 1 | 2,
  grieferSlots: number[],
  quitterSlots: number[],
): Promise<void> {
  const match = await resolveById(interaction, matchId);
  const profile = await profileForMatch(match);

  if (profile.postMatchStats !== 'none') {
    await showReportStatsStep(interaction, match, winningTeam, grieferSlots, quitterSlots);
    return;
  }

  await showReportConfirmStep(interaction, match, winningTeam, grieferSlots, quitterSlots);
}

async function handleReportStatsSkip(
  interaction: ButtonInteraction,
  matchId: string,
  _winningTeam: 1 | 2,
  _grieferSlots: number[],
  _quitterSlots: number[],
): Promise<void> {
  await resolveById(interaction, matchId);
  throw new MatchServiceError(WOS_MATCH_REPORT_REQUIRED_MESSAGE);
}

async function handleReportStatsRefresh(
  interaction: ButtonInteraction,
  matchId: string,
  winningTeam: 1 | 2,
  grieferSlots: number[],
  quitterSlots: number[],
): Promise<void> {
  const match = await resolveById(interaction, matchId);
  await showReportStatsStep(interaction, match, winningTeam, grieferSlots, quitterSlots);
}

async function handleUploadStatsEntry(interaction: ButtonInteraction): Promise<void> {
  const match = await resolveByMessage(interaction);
  const profile = await profileForMatch(match);

  if (profile.postMatchStats === 'none') {
    throw new MatchServiceError('This game does not accept match stats reports.');
  }

  await replyEphemeral(
    interaction,
    [
      'Upload the WOS bot match report file while the match is in progress:',
      `\`/match upload_report match_id:${match.id} report:<attachment>\``,
      '',
      'After uploading, continue **Report Winner** and tap **Refresh** on the stats step.',
    ].join('\n'),
  );
}

async function handleConfirmResult(
  interaction: ButtonInteraction,
  matchId: string,
  winningTeam: 1 | 2,
  grieferSlots: number[],
  quitterSlots: number[],
): Promise<void> {
  const match = await resolveById(interaction, matchId);
  const profile = await profileForMatch(match);
  await showWorking(
    interaction,
    'Updating ratings and completing the match… This can take a few seconds.',
  );

  const completed = await completeMatch(matchId, winningTeam, quitterSlots, grieferSlots);
  void refreshAllLeaderboardChannels(interaction.client).catch(() => undefined);
  await syncLobbyDiscordMessage(interaction.client, completed.match, 'completed', {
    ratingPreview: completed.ratingPreview,
    postToMatchLog: true,
  });
  await interaction.editReply({
    content: `Match \`${matchId}\` completed. Winner: **${winnerLabel(winningTeam, profile)}**.`,
    components: [],
  });
}

async function handleQuittersSet(
  interaction: StringSelectMenuInteraction,
  matchId: string,
): Promise<void> {
  await resolveById(interaction, matchId);
  await showWorking(interaction, 'Saving quitters…');

  const quitterSlots = interaction.values.map((slot) => Number(slot));
  const updated = await setQuitters(matchId, quitterSlots);
  await syncLobbyDiscordMessage(interaction.client, updated, 'started');
  await interaction.editReply({
    content: `Quitters updated.\n${formatQuitterSummary(updated, quitterSlots)}`,
    components: [],
  });
}

/** Save pre-selected quitters without changing the select (Discord won't fire it). */
async function handleQuittersKeep(
  interaction: ButtonInteraction,
  matchId: string,
  quitterSlots: number[],
): Promise<void> {
  await resolveById(interaction, matchId);
  await showWorking(interaction, 'Saving quitters…');

  const updated = await setQuitters(matchId, quitterSlots);
  await syncLobbyDiscordMessage(interaction.client, updated, 'started');
  await interaction.editReply({
    content: `Quitters updated.\n${formatQuitterSummary(updated, quitterSlots)}`,
    components: [],
  });
}

async function handleGriefersSet(
  interaction: StringSelectMenuInteraction,
  matchId: string,
): Promise<void> {
  await resolveById(interaction, matchId);
  await showWorking(interaction, 'Saving griefers…');

  const grieferSlots = interaction.values.map((slot) => Number(slot));
  const updated = await setGriefers(matchId, grieferSlots);
  await syncLobbyDiscordMessage(interaction.client, updated, 'started');
  await interaction.editReply({
    content: `Griefers updated.\n${formatGrieferSummary(updated, grieferSlots)}`,
    components: [],
  });
}

async function handleGriefersKeep(
  interaction: ButtonInteraction,
  matchId: string,
  grieferSlots: number[],
): Promise<void> {
  await resolveById(interaction, matchId);
  await showWorking(interaction, 'Saving griefers…');

  const updated = await setGriefers(matchId, grieferSlots);
  await syncLobbyDiscordMessage(interaction.client, updated, 'started');
  await interaction.editReply({
    content: `Griefers updated.\n${formatGrieferSummary(updated, grieferSlots)}`,
    components: [],
  });
}

async function handleCancelConfirm(
  interaction: ButtonInteraction,
  matchId: string,
  grieferSlots: number[],
): Promise<void> {
  await resolveById(interaction, matchId);
  await showWorking(
    interaction,
    'Cancelling the match… Applying quitter penalties and recording griefer season tax if any are marked.',
  );

  const cancelled = await cancelInProgressMatch(matchId, grieferSlots);
  await syncLobbyDiscordMessage(interaction.client, cancelled, 'cancelled');
  await interaction.editReply({
    content: `Match \`${matchId}\` cancelled.`,
    components: [],
  });
}

async function handleCancelNo(interaction: ButtonInteraction, matchId: string): Promise<void> {
  await resolveById(interaction, matchId);
  await updateEphemeral(interaction, `Match \`${matchId}\` was not cancelled.`);
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const parts = parseCustomId(interaction.customId);
  log.debug({ customId: interaction.customId, userId: interaction.user.id }, 'Match button');

  await safeHandle(interaction, async () => {
    if (interaction.customId === 'match:upload_stats') {
      await handleUploadStatsEntry(interaction);
      return;
    }

    if (interaction.customId === 'match:report') {
      await handleReportEntry(interaction);
      return;
    }

    if (interaction.customId === 'match:quitters') {
      await handleQuittersEntry(interaction);
      return;
    }

    if (interaction.customId === 'match:griefers') {
      await handleGriefersEntry(interaction);
      return;
    }

    if (interaction.customId === 'match:cancel') {
      await handleCancelEntry(interaction);
      return;
    }

    if (parts[1] === 'rw' && parts[2] === 'gskip' && parts[3]) {
      await handleReportGrieferSkip(interaction, parts[3]);
      return;
    }

    if (parts[1] === 'rw' && parts[2] === 'gok' && parts[3] && parts[4]) {
      await handleReportGriefersKeep(interaction, parts[3], decodeSlots(parts[4]));
      return;
    }

    if (parts[1] === 'rw' && parts[2] === 'qskip' && parts[3] && parts[4]) {
      await handleReportQuitterSkip(interaction, parts[3], decodeSlots(parts[4]));
      return;
    }

    if (parts[1] === 'rw' && parts[2] === 'qok' && parts[3] && parts[4] && parts[5]) {
      await handleReportQuittersKeep(
        interaction,
        parts[3],
        decodeSlots(parts[4]),
        decodeSlots(parts[5]),
      );
      return;
    }

    if (parts[1] === 'qok' && parts[2] && parts[3]) {
      await handleQuittersKeep(interaction, parts[2], decodeSlots(parts[3]));
      return;
    }

    if (parts[1] === 'gok' && parts[2] && parts[3]) {
      await handleGriefersKeep(interaction, parts[2], decodeSlots(parts[3]));
      return;
    }

    if (
      parts[1] === 'rw' &&
      parts[2] === 'statskip' &&
      parts[3] &&
      parts[4] &&
      parts[5] &&
      parts[6]
    ) {
      await handleReportStatsSkip(
        interaction,
        parts[3],
        decodeTeam(parts[4]),
        decodeSlots(parts[5]),
        decodeSlots(parts[6]),
      );
      return;
    }

    if (
      parts[1] === 'rw' &&
      parts[2] === 'statrefresh' &&
      parts[3] &&
      parts[4] &&
      parts[5] &&
      parts[6]
    ) {
      await handleReportStatsRefresh(
        interaction,
        parts[3],
        decodeTeam(parts[4]),
        decodeSlots(parts[5]),
        decodeSlots(parts[6]),
      );
      return;
    }

    if (parts[1] === 'rw' && parts[2] === 'win' && parts[3] && parts[4] && parts[5] && parts[6]) {
      await handleWinnerChoice(
        interaction,
        parts[3],
        decodeTeam(parts[4]),
        decodeSlots(parts[5]),
        decodeSlots(parts[6]),
      );
      return;
    }

    if (parts[1] === 'rw' && parts[2] === 'ok' && parts[3] && parts[4] && parts[5] && parts[6]) {
      await handleConfirmResult(
        interaction,
        parts[3],
        decodeTeam(parts[4]),
        decodeSlots(parts[5]),
        decodeSlots(parts[6]),
      );
      return;
    }

    if (parts[1] === 'cancel' && parts[2] === 'skip' && parts[3]) {
      await handleCancelSkip(interaction, parts[3]);
      return;
    }

    if (parts[1] === 'cancel' && parts[2] === 'gok' && parts[3] && parts[4]) {
      await handleCancelGriefersKeep(interaction, parts[3], decodeSlots(parts[4]));
      return;
    }

    if (parts[1] === 'cancel' && parts[2] === 'ok' && parts[3] && parts[4]) {
      await handleCancelConfirm(interaction, parts[3], decodeSlots(parts[4]));
      return;
    }

    if (parts[1] === 'cancel' && parts[2] === 'ok' && parts[3]) {
      await handleCancelConfirm(interaction, parts[3], []);
      return;
    }

    if (parts[1] === 'cancel' && parts[2] === 'no' && parts[3]) {
      await handleCancelNo(interaction, parts[3]);
      return;
    }

    log.warn({ customId: interaction.customId }, 'Unhandled match button');
  });
}

async function handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const parts = parseCustomId(interaction.customId);
  log.debug(
    { customId: interaction.customId, values: interaction.values, userId: interaction.user.id },
    'Match select',
  );

  await safeHandle(interaction, async () => {
    if (parts[1] === 'rw' && parts[2] === 'g' && parts[3]) {
      await handleReportGriefers(interaction, parts[3]);
      return;
    }

    if (parts[1] === 'rw' && parts[2] === 'q' && parts[3] && parts[4]) {
      await handleReportQuitters(interaction, parts[3], decodeSlots(parts[4]));
      return;
    }

    if (parts[1] === 'qset' && parts[2]) {
      await handleQuittersSet(interaction, parts[2]);
      return;
    }

    if (parts[1] === 'cancel' && parts[2] === 'gset' && parts[3]) {
      await handleCancelGriefers(interaction, parts[3]);
      return;
    }

    if (parts[1] === 'gset' && parts[2]) {
      await handleGriefersSet(interaction, parts[2]);
      return;
    }

    log.warn({ customId: interaction.customId }, 'Unhandled match select');
  });
}

export async function handleMatchInteraction(interaction: Interaction): Promise<boolean> {
  if (interaction.isButton() && interaction.customId.startsWith('match:')) {
    await handleButton(interaction);
    return true;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('match:')) {
    await handleSelect(interaction);
    return true;
  }

  return false;
}
