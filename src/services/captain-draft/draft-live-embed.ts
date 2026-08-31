import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { currentCaptainKey, isDraftComplete } from './draft-logic.js';
import type { CaptainDraftStatus, DraftParticipant, DraftState, DraftTeam } from './draft-types.js';
import { formatParticipantDisplay } from './draft-team-embed.js';

const LIVE_DRAFT_COLOR = 0x5865f2;

const DISCORD_FIELD_MAX = 1024;

function sortedTeams(state: DraftState): DraftTeam[] {
  return [...state.teams].sort((a, b) => a.pickOrderIndex - b.pickOrderIndex);
}

function formatTeamRosterLines(team: DraftTeam): string {
  if (team.roster.length === 0) {
    return '_Empty_';
  }

  return team.roster
    .map((player) => {
      const display = formatParticipantDisplay(player);
      const prefix = player.key === team.captainKey ? '👑' : '•';
      return `${prefix} ${display}`;
    })
    .join('\n');
}

function truncateFieldValue(value: string, max = DISCORD_FIELD_MAX): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

function formatAvailablePool(pool: DraftParticipant[]): string {
  if (pool.length === 0) {
    return '_None — draft complete_';
  }

  const labels = pool.map((player) => formatParticipantDisplay(player)).join(', ');
  return truncateFieldValue(labels);
}

function roundLabel(pickIndex: number, teamCount: number): string {
  if (teamCount <= 0) {
    return '';
  }
  const round = Math.floor(pickIndex / teamCount) + 1;
  const reversing = Math.floor(pickIndex / teamCount) % 2 === 1;
  return `Round ${round} · ${reversing ? 'reversing' : 'forward'}`;
}

function buildActiveTitle(state: DraftState): string {
  const totalPicks = state.pickIndex + state.memberPool.length;
  const currentPick = state.pickIndex + 1;

  if (isDraftComplete(state)) {
    return 'Captain Draft — Complete';
  }

  return `Captain Draft — Pick ${currentPick} of ${totalPicks}`;
}

function buildLiveDescription(state: DraftState, status: CaptainDraftStatus): string {
  if (status === 'SETUP') {
    const captainCount = state.captains.length;
    const memberCount = state.memberPool.length;
    return `Waiting to begin.\n\nCaptains: **${captainCount}** · Pool: **${memberCount}**`;
  }

  if (status === 'CANCELLED') {
    return 'This draft was cancelled.';
  }

  if (status === 'COMPLETE' || isDraftComplete(state)) {
    return 'All players have been drafted.';
  }

  return roundLabel(state.pickIndex, state.teams.length);
}

/** Public live draft embed for SETUP, ACTIVE, or COMPLETE. */
export function buildLiveDraftEmbed(state: DraftState, status: CaptainDraftStatus): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(LIVE_DRAFT_COLOR)
    .setTitle(buildActiveTitle(state))
    .setDescription(buildLiveDescription(state, status));

  if (status !== 'ACTIVE' && status !== 'COMPLETE') {
    return embed;
  }

  const onClockCaptainKey =
    status === 'ACTIVE' && !isDraftComplete(state) ? currentCaptainKey(state) : null;

  for (const team of sortedTeams(state)) {
    const isOnClock = team.captainKey === onClockCaptainKey;
    const name = isOnClock ? `🎯 ON THE CLOCK — ${team.displayName}` : team.displayName;

    embed.addFields({
      name,
      value: truncateFieldValue(formatTeamRosterLines(team)),
    });
  }

  embed.addFields({
    name: `Available (${state.memberPool.length})`,
    value: formatAvailablePool(state.memberPool),
  });

  return embed;
}

/** Pick button custom id prefix for captain draft interactions. */
export function buildPickButtonCustomId(draftId: string): string {
  return `cdraft:pick_btn:${draftId}`;
}

/** Pick-player button row; omitted when draft is not actively picking. */
export function buildLiveDraftComponents(
  draftId: string,
  status: CaptainDraftStatus,
): ActionRowBuilder<ButtonBuilder>[] {
  if (status !== 'ACTIVE') {
    return [];
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildPickButtonCustomId(draftId))
      .setLabel('Pick player')
      .setStyle(ButtonStyle.Primary),
  );

  return [row];
}
