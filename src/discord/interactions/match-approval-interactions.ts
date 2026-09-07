import {
  GuildMember,
  MessageFlags,
  type ActionRowBuilder,
  type ButtonBuilder,
  type ButtonInteraction,
  type Interaction,
  type MessageComponentInteraction,
  type StringSelectMenuBuilder,
} from 'discord.js';
import { sendReplacingEphemeral, touchEphemeralSession } from '../../lib/ephemeral-reply.js';
import { createLogger } from '../../lib/logger.js';
import { resolveGuildConfig, winnerLabel } from '../../services/guild/index.js';
import {
  refreshGuildGrieferLeaderboard,
  refreshGuildQuitterLeaderboard,
  refreshLeagueLeaderboard,
} from '../../services/leaderboard/index.js';
import {
  approveWaitingMatch,
  assertHasMatchModRole,
  getGameProfileForMatch,
  getMatchById,
  MatchServiceError,
  rejectWaitingMatch,
  requireLeagueId,
  setApprovalWinner,
  setGriefers,
  setQuitters,
  winningTeamFromPlayers,
  type MatchWithPlayers,
} from '../../services/match/index.js';
import {
  buildMatchApprovalGrieferKeepRow,
  buildMatchApprovalGrieferSelect,
  buildMatchApprovalQuitterKeepRow,
  buildMatchApprovalQuitterSelect,
  buildMatchApprovalWinnerButtons,
  MATCH_APPROVAL_CUSTOM_ID_PREFIX,
  parseMatchApprovalCustomId,
  syncMatchApprovalMessage,
  type MatchApprovalAction,
} from '../../services/match/match-approval-preview.js';

const log = createLogger('match-approval-interactions');

type ComponentRow = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;

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

async function assertApprovalMod(interaction: MessageComponentInteraction): Promise<void> {
  if (!interaction.guildId) {
    throw new MatchServiceError('This action can only be used in a server.');
  }

  const config = await resolveGuildConfig(interaction.guildId);
  assertHasMatchModRole({
    actorDiscordId: interaction.user.id,
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId: config.matchModRoleId,
  });
}

async function requireWaitingMatch(matchId: string): Promise<MatchWithPlayers> {
  const match = await getMatchById(matchId);
  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }
  if (match.status !== 'WAITING_FOR_APPROVAL') {
    throw new MatchServiceError('This match is not awaiting approval.');
  }
  return match;
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

async function showWorking(
  interaction: MessageComponentInteraction,
  content: string,
): Promise<void> {
  await updateEphemeral(interaction, content, []);
}

function preselectedQuitterSlots(match: MatchWithPlayers): number[] {
  return match.players.filter((player) => player.isQuitter).map((player) => player.slot);
}

function preselectedGrieferSlots(match: MatchWithPlayers): number[] {
  return match.players.filter((player) => player.isGriefer).map((player) => player.slot);
}

function formatSlotSummary(
  match: MatchWithPlayers,
  slots: number[],
  emptyLabel: string,
  header: string,
): string {
  const slotSet = new Set(slots);
  const players = [...match.players]
    .sort((a, b) => a.slot - b.slot)
    .filter((player) => slotSet.has(player.slot));
  if (players.length === 0) {
    return emptyLabel;
  }
  return `${header}\n${players.map((player) => `- Slot ${player.slot}: ${player.player.username}`).join('\n')}`;
}

async function handleQuittersEntry(interaction: ButtonInteraction, matchId: string): Promise<void> {
  await assertApprovalMod(interaction);
  const match = await requireWaitingMatch(matchId);

  if (match.players.length === 0) {
    throw new MatchServiceError('This match has no players to update.');
  }

  const preselected = preselectedQuitterSlots(match);
  const components: ComponentRow[] = [buildMatchApprovalQuitterSelect(match)];
  const keepRow = buildMatchApprovalQuitterKeepRow(matchId, preselected);
  if (keepRow) {
    components.push(keepRow);
  }

  const hint =
    preselected.length > 0
      ? 'Select quitters, or Save selected to keep the current flags:'
      : 'Select any players who quit:';

  await replyEphemeral(interaction, hint, components);
}

async function handleGriefersEntry(interaction: ButtonInteraction, matchId: string): Promise<void> {
  await assertApprovalMod(interaction);
  const match = await requireWaitingMatch(matchId);

  if (match.players.length === 0) {
    throw new MatchServiceError('This match has no players to update.');
  }

  const preselected = preselectedGrieferSlots(match);
  const components: ComponentRow[] = [buildMatchApprovalGrieferSelect(match)];
  const keepRow = buildMatchApprovalGrieferKeepRow(matchId, preselected);
  if (keepRow) {
    components.push(keepRow);
  }

  const hint =
    preselected.length > 0
      ? 'Select griefers (bug abuse), or Save selected to keep the current flags:'
      : 'Select any griefers (bug abuse):';

  await replyEphemeral(interaction, hint, components);
}

async function handleWinnerEntry(interaction: ButtonInteraction, matchId: string): Promise<void> {
  await assertApprovalMod(interaction);
  const match = await requireWaitingMatch(matchId);
  const profile = await getGameProfileForMatch(match);

  await replyEphemeral(interaction, 'Choose the winning team:', [
    buildMatchApprovalWinnerButtons(matchId, profile),
  ]);
}

async function persistQuitters(
  interaction: MessageComponentInteraction,
  matchId: string,
  slots: number[],
): Promise<void> {
  await assertApprovalMod(interaction);
  await requireWaitingMatch(matchId);
  await showWorking(interaction, 'Saving quitters…');

  const updated = await setQuitters(matchId, slots);
  await syncMatchApprovalMessage(interaction.client, updated, 'waiting');
  await interaction.editReply({
    content: `Quitters updated.\n${formatSlotSummary(updated, slots, 'Quitters: none', 'Quitters:')}`,
    components: [],
  });
}

async function persistGriefers(
  interaction: MessageComponentInteraction,
  matchId: string,
  slots: number[],
): Promise<void> {
  await assertApprovalMod(interaction);
  await requireWaitingMatch(matchId);
  await showWorking(interaction, 'Saving griefers…');

  const updated = await setGriefers(matchId, slots);
  await syncMatchApprovalMessage(interaction.client, updated, 'waiting');
  await interaction.editReply({
    content: `Griefers updated.\n${formatSlotSummary(updated, slots, 'Griefers: none', 'Griefers:')}`,
    components: [],
  });
}

async function handleWin(
  interaction: ButtonInteraction,
  matchId: string,
  winningTeam: 1 | 2,
): Promise<void> {
  await assertApprovalMod(interaction);
  await requireWaitingMatch(matchId);
  await showWorking(interaction, 'Saving winner…');

  const updated = await setApprovalWinner(matchId, winningTeam);
  const profile = await getGameProfileForMatch(updated);
  await syncMatchApprovalMessage(interaction.client, updated, 'waiting');
  await interaction.editReply({
    content: `Winner set to **${winnerLabel(winningTeam, profile)}**.`,
    components: [],
  });
}

async function handleApprove(interaction: ButtonInteraction, matchId: string): Promise<void> {
  await assertApprovalMod(interaction);
  await requireWaitingMatch(matchId);
  await interaction.deferUpdate();

  const result = await approveWaitingMatch(matchId);
  const winningTeam = winningTeamFromPlayers(result.match.players);

  await syncMatchApprovalMessage(interaction.client, result.match, 'completed', {
    ratingPreview: result.ratingPreview,
    winningTeam,
  });
  await refreshLeagueLeaderboard(interaction.client, requireLeagueId(result.match));
  if (interaction.guildId) {
    await refreshGuildQuitterLeaderboard(interaction.client, interaction.guildId);
    await refreshGuildGrieferLeaderboard(interaction.client, interaction.guildId);
  }
}

async function handleReject(interaction: ButtonInteraction, matchId: string): Promise<void> {
  await assertApprovalMod(interaction);
  await requireWaitingMatch(matchId);
  await interaction.deferUpdate();

  const updated = await rejectWaitingMatch(matchId);
  const reason = `rejected by <@${interaction.user.id}>`;
  await syncMatchApprovalMessage(interaction.client, updated, 'cancelled', {
    cancelReason: reason,
  });
}

async function dispatchAction(
  interaction: MessageComponentInteraction,
  action: MatchApprovalAction,
): Promise<void> {
  switch (action.kind) {
    case 'quitters':
      if (!interaction.isButton()) {
        return;
      }
      await handleQuittersEntry(interaction, action.matchId);
      return;
    case 'griefers':
      if (!interaction.isButton()) {
        return;
      }
      await handleGriefersEntry(interaction, action.matchId);
      return;
    case 'winner':
      if (!interaction.isButton()) {
        return;
      }
      await handleWinnerEntry(interaction, action.matchId);
      return;
    case 'win':
      if (!interaction.isButton()) {
        return;
      }
      await handleWin(interaction, action.matchId, action.winningTeam);
      return;
    case 'approve':
      if (!interaction.isButton()) {
        return;
      }
      await handleApprove(interaction, action.matchId);
      return;
    case 'reject':
      if (!interaction.isButton()) {
        return;
      }
      await handleReject(interaction, action.matchId);
      return;
    case 'qset':
      if (!interaction.isStringSelectMenu()) {
        return;
      }
      await persistQuitters(
        interaction,
        action.matchId,
        interaction.values.map((value) => Number(value)).filter((slot) => Number.isInteger(slot)),
      );
      return;
    case 'gset':
      if (!interaction.isStringSelectMenu()) {
        return;
      }
      await persistGriefers(
        interaction,
        action.matchId,
        interaction.values.map((value) => Number(value)).filter((slot) => Number.isInteger(slot)),
      );
      return;
    case 'qok':
      if (!interaction.isButton()) {
        return;
      }
      await persistQuitters(interaction, action.matchId, action.slots);
      return;
    case 'gok':
      if (!interaction.isButton()) {
        return;
      }
      await persistGriefers(interaction, action.matchId, action.slots);
      return;
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
    }
  }
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
        'Match approval interaction rejected',
      );

      if (interaction.deferred || interaction.replied) {
        // Channel-message deferUpdate cannot use editReply for ephemeral deny; followUp instead.
        if (interaction.deferred && !interaction.replied) {
          try {
            await interaction.followUp({
              content: error.message,
              flags: MessageFlags.Ephemeral,
            });
            return;
          } catch {
            // fall through to editReply for ephemeral wizard flows
          }
        }
        await interaction.editReply({ content: error.message, components: [] }).catch(async () => {
          await interaction.followUp({
            content: error.message,
            flags: MessageFlags.Ephemeral,
          });
        });
        return;
      }

      await replyEphemeral(interaction, error.message);
      return;
    }

    throw error;
  }
}

/**
 * Handle `match:ap:*` button/select interactions for API-ingested waiting matches.
 * Returns true when the customId belongs to this feature (even if malformed).
 */
export async function handleMatchApprovalInteraction(interaction: Interaction): Promise<boolean> {
  const isComponent =
    (interaction.isButton() || interaction.isStringSelectMenu()) &&
    interaction.customId.startsWith(MATCH_APPROVAL_CUSTOM_ID_PREFIX);

  if (!isComponent) {
    return false;
  }

  const parsed = parseMatchApprovalCustomId(interaction.customId);
  if (!parsed) {
    log.warn({ customId: interaction.customId }, 'Malformed match approval customId');
    return true;
  }

  log.debug(
    { customId: interaction.customId, userId: interaction.user.id, kind: parsed.kind },
    'Match approval interaction',
  );

  await safeHandle(interaction as MessageComponentInteraction, async () => {
    await dispatchAction(interaction as MessageComponentInteraction, parsed);
  });

  return true;
}
