import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  MessageFlags,
  StringSelectMenuBuilder,
} from 'discord.js';
import type {
  ButtonInteraction,
  Interaction,
  MessageComponentInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import { createLogger } from '../lib/logger.js';
import {
  resolveInProgressMatchByMessageId,
  syncLobbyDiscordMessage,
} from '../services/lobby-actions.js';
import { refreshAllLeaderboardChannels } from '../services/leaderboard-channel.js';
import {
  cancelInProgressMatch,
  completeMatch,
  setQuitters,
} from '../services/match-report.js';
import {
  getMatchById,
  MatchServiceError,
  type MatchWithPlayers,
} from '../services/match-service.js';
import { assertCanManageMatch } from '../services/match-auth.js';
import { resolveGuildConfig } from '../services/guild-config.js';

const log = createLogger('match-interactions');

type MatchPlayer = MatchWithPlayers['players'][number];
type ComponentRow =
  | ActionRowBuilder<ButtonBuilder>
  | ActionRowBuilder<StringSelectMenuBuilder>;

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

function encodeSlots(slots: number[]): string {
  const normalized = [...new Set(slots)].sort((a, b) => a - b);
  return normalized.length > 0 ? normalized.join('-') : '-';
}

function decodeSlots(slotsCsv: string | undefined): number[] {
  if (!slotsCsv || slotsCsv === '-') {
    return [];
  }

  return slotsCsv
    .split('-')
    .map((slot) => Number(slot))
    .filter((slot) => Number.isInteger(slot));
}

function sortedPlayers(match: MatchWithPlayers): MatchPlayer[] {
  return [...match.players].sort((a, b) => a.slot - b.slot);
}

function teamLabel(team: 1 | 2): string {
  return team === 1 ? 'Team A' : 'Team B';
}

function decodeTeam(teamRaw: string | undefined): 1 | 2 {
  if (teamRaw === '1' || teamRaw === '2') {
    return Number(teamRaw) as 1 | 2;
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

/** Slots already flagged as quitters on the match (for select defaults / Continue). */
function preselectedQuitterSlots(match: MatchWithPlayers): number[] {
  return sortedPlayers(match)
    .filter((player) => player.isQuitter)
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
  kind: 'report' | 'save',
  quitterSlots: number[],
): ActionRowBuilder<ButtonBuilder> | null {
  if (quitterSlots.length === 0) {
    return null;
  }

  const slotsCsv = encodeSlots(quitterSlots);
  const customId =
    kind === 'report'
      ? `match:rw:qok:${matchId}:${slotsCsv}`
      : `match:qok:${matchId}:${slotsCsv}`;

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(kind === 'report' ? 'Continue with selected' : 'Save selected')
      .setStyle(ButtonStyle.Primary),
  );
}

function buildReportSkipRow(matchId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:rw:skip:${matchId}`)
      .setLabel('No Quitters')
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildWinnerRow(matchId: string, quitterSlots: number[]): ActionRowBuilder<ButtonBuilder> {
  const slotsCsv = encodeSlots(quitterSlots);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:rw:win:${matchId}:1:${slotsCsv}`)
      .setLabel('Team A Won')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`match:rw:win:${matchId}:2:${slotsCsv}`)
      .setLabel('Team B Won')
      .setStyle(ButtonStyle.Primary),
  );
}

function buildConfirmRow(
  matchId: string,
  winningTeam: 1 | 2,
  quitterSlots: number[],
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:rw:ok:${matchId}:${winningTeam}:${encodeSlots(quitterSlots)}`)
      .setLabel('Confirm Result')
      .setStyle(ButtonStyle.Success),
  );
}

function buildCancelConfirmRow(matchId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match:cancel:ok:${matchId}`)
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
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content, components, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({ content, components, flags: MessageFlags.Ephemeral });
}

async function updateEphemeral(
  interaction: MessageComponentInteraction,
  content: string,
  components: ComponentRow[] = [],
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content, components });
    return;
  }

  await interaction.update({ content, components });
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

  const preselected = preselectedQuitterSlots(match);
  const components: ComponentRow[] = [
    buildQuitterSelectRow(match, `match:rw:q:${match.id}`),
  ];
  const continueRow = buildQuitterContinueRow(match.id, 'report', preselected);
  if (continueRow) {
    components.push(continueRow);
  }
  components.push(buildReportSkipRow(match.id));

  const hint =
    preselected.length > 0
      ? 'Select any players who quit (or Continue with selected), then choose the winner:'
      : 'Select any players who quit, then choose the winner:';

  await replyEphemeral(interaction, hint, components);
}

async function handleQuittersEntry(interaction: ButtonInteraction): Promise<void> {
  const match = await resolveByMessage(interaction);

  if (match.players.length === 0) {
    throw new MatchServiceError('This match has no players to update.');
  }

  const preselected = preselectedQuitterSlots(match);
  const components: ComponentRow[] = [
    buildQuitterSelectRow(match, `match:qset:${match.id}`),
  ];
  const continueRow = buildQuitterContinueRow(match.id, 'save', preselected);
  if (continueRow) {
    components.push(continueRow);
  }

  const hint =
    preselected.length > 0
      ? 'Select players who quit, or Save selected to keep the current flags:'
      : 'Select players who quit:';

  await replyEphemeral(interaction, hint, components);
}

async function handleCancelEntry(interaction: ButtonInteraction): Promise<void> {
  const match = await resolveByMessage(interaction);

  await replyEphemeral(
    interaction,
    `Cancel match \`${match.id}\`? Quitter penalties will be applied if quitters are already marked.`,
    [buildCancelConfirmRow(match.id)],
  );
}

async function handleReportQuitters(
  interaction: StringSelectMenuInteraction,
  matchId: string,
): Promise<void> {
  const match = await resolveById(interaction, matchId);
  const quitterSlots = interaction.values.map((slot) => Number(slot));

  await updateEphemeral(
    interaction,
    `${formatQuitterSummary(match, quitterSlots)}\n\nChoose the winner:`,
    [buildWinnerRow(matchId, quitterSlots)],
  );
}

/** Continue Report Winner with pre-selected quitters (select unchanged). */
async function handleReportQuittersKeep(
  interaction: ButtonInteraction,
  matchId: string,
  quitterSlots: number[],
): Promise<void> {
  const match = await resolveById(interaction, matchId);

  await updateEphemeral(
    interaction,
    `${formatQuitterSummary(match, quitterSlots)}\n\nChoose the winner:`,
    [buildWinnerRow(matchId, quitterSlots)],
  );
}

async function handleReportSkip(interaction: ButtonInteraction, matchId: string): Promise<void> {
  await resolveById(interaction, matchId);
  await updateEphemeral(interaction, 'Quitters: none\n\nChoose the winner:', [
    buildWinnerRow(matchId, []),
  ]);
}

async function handleWinnerChoice(
  interaction: ButtonInteraction,
  matchId: string,
  winningTeam: 1 | 2,
  quitterSlots: number[],
): Promise<void> {
  const match = await resolveById(interaction, matchId);
  const content = [
    `Winner: **${teamLabel(winningTeam)}**`,
    formatQuitterSummary(match, quitterSlots),
    '',
    'Confirm to complete the match and apply ratings.',
  ].join('\n');

  await updateEphemeral(interaction, content, [
    buildConfirmRow(matchId, winningTeam, quitterSlots),
  ]);
}

async function handleConfirmResult(
  interaction: ButtonInteraction,
  matchId: string,
  winningTeam: 1 | 2,
  quitterSlots: number[],
): Promise<void> {
  await resolveById(interaction, matchId);
  await showWorking(
    interaction,
    'Updating ratings and completing the match… This can take a few seconds.',
  );

  const completed = await completeMatch(matchId, winningTeam, quitterSlots);
  void refreshAllLeaderboardChannels(interaction.client).catch(() => undefined);
  await syncLobbyDiscordMessage(interaction.client, completed.match, 'completed', {
    ratingPreview: completed.ratingPreview,
  });
  await interaction.editReply({
    content: `Match \`${matchId}\` completed. Winner: **${teamLabel(winningTeam)}**.`,
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

async function handleCancelConfirm(
  interaction: ButtonInteraction,
  matchId: string,
): Promise<void> {
  await resolveById(interaction, matchId);
  await showWorking(
    interaction,
    'Cancelling the match… Applying quitter penalties if any are marked.',
  );

  const cancelled = await cancelInProgressMatch(matchId);
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
    if (interaction.customId === 'match:report') {
      await handleReportEntry(interaction);
      return;
    }

    if (interaction.customId === 'match:quitters') {
      await handleQuittersEntry(interaction);
      return;
    }

    if (interaction.customId === 'match:cancel') {
      await handleCancelEntry(interaction);
      return;
    }

    if (parts[1] === 'rw' && parts[2] === 'skip' && parts[3]) {
      await handleReportSkip(interaction, parts[3]);
      return;
    }

    if (parts[1] === 'rw' && parts[2] === 'qok' && parts[3] && parts[4]) {
      await handleReportQuittersKeep(interaction, parts[3], decodeSlots(parts[4]));
      return;
    }

    if (parts[1] === 'qok' && parts[2] && parts[3]) {
      await handleQuittersKeep(interaction, parts[2], decodeSlots(parts[3]));
      return;
    }

    if (parts[1] === 'rw' && parts[2] === 'win' && parts[3] && parts[4] && parts[5]) {
      await handleWinnerChoice(interaction, parts[3], decodeTeam(parts[4]), decodeSlots(parts[5]));
      return;
    }

    if (parts[1] === 'rw' && parts[2] === 'ok' && parts[3] && parts[4] && parts[5]) {
      await handleConfirmResult(interaction, parts[3], decodeTeam(parts[4]), decodeSlots(parts[5]));
      return;
    }

    if (parts[1] === 'cancel' && parts[2] === 'ok' && parts[3]) {
      await handleCancelConfirm(interaction, parts[3]);
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
    if (parts[1] === 'rw' && parts[2] === 'q' && parts[3]) {
      await handleReportQuitters(interaction, parts[3]);
      return;
    }

    if (parts[1] === 'qset' && parts[2]) {
      await handleQuittersSet(interaction, parts[2]);
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
