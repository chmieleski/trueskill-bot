import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { currentCaptainKey, findParticipant, isDraftComplete } from './draft-logic.js';
import type { CaptainDraftStatus, DraftParticipant, DraftState, DraftTeam } from './draft-types.js';
import {
  TEAM_EMBED_COLORS,
  formatParticipantDisplay,
  formatTeamRosterList,
} from './draft-team-embed.js';

const LIVE_DRAFT_COLOR = 0x5865f2;
const DISCORD_FIELD_MAX = 1024;
const MAX_EMBEDS_PER_MESSAGE = 10;

function sortedTeams(state: DraftState): DraftTeam[] {
  return [...state.teams].sort((a, b) => a.pickOrderIndex - b.pickOrderIndex);
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

function buildTeamDraftEmbed(
  team: DraftTeam,
  teamIndex: number,
  isOnClock: boolean,
  completedAt?: Date,
): EmbedBuilder {
  const captain = team.roster.find((player) => player.key === team.captainKey) ?? team.roster[0];
  const color = TEAM_EMBED_COLORS[teamIndex % TEAM_EMBED_COLORS.length]!;
  const title = isOnClock ? `🎯 ${team.displayName}` : team.displayName;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .addFields(
      {
        name: 'Captain',
        value: captain ? formatParticipantDisplay(captain) : '—',
        inline: true,
      },
      {
        name: 'Pick Order',
        value: `#${team.pickOrderIndex + 1}`,
        inline: true,
      },
      {
        name: 'Roster',
        value: truncateFieldValue(formatTeamRosterList(team)),
      },
    )
    .setFooter({ text: 'Captain draft' });

  if (completedAt) {
    embed.setTimestamp(completedAt);
  }

  return embed;
}

function buildAvailablePoolEmbed(pool: DraftParticipant[]): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(LIVE_DRAFT_COLOR)
    .setTitle(`Available (${pool.length})`)
    .setDescription(formatAvailablePool(pool))
    .setFooter({ text: 'Captain draft' });
}

/** Ping the captain who is on the clock during an active draft. */
export function buildLiveDraftContent(state: DraftState, status: CaptainDraftStatus): string {
  if (status !== 'ACTIVE' || isDraftComplete(state)) {
    return '';
  }

  const captainKey = currentCaptainKey(state);
  if (!captainKey) {
    return '';
  }

  const captain = findParticipant(state, captainKey);
  if (!captain?.discordId) {
    return '';
  }

  return `<@${captain.discordId}> — your turn to pick!`;
}

/** One embed per team during ACTIVE/COMPLETE; summary embed for SETUP/CANCELLED. */
export function buildLiveDraftEmbeds(
  state: DraftState,
  status: CaptainDraftStatus,
  completedAt?: Date,
): EmbedBuilder[] {
  if (status !== 'ACTIVE' && status !== 'COMPLETE') {
    return [
      new EmbedBuilder()
        .setColor(LIVE_DRAFT_COLOR)
        .setTitle(buildActiveTitle(state))
        .setDescription(buildLiveDescription(state, status)),
    ];
  }

  const onClockCaptainKey =
    status === 'ACTIVE' && !isDraftComplete(state) ? currentCaptainKey(state) : null;
  const teams = sortedTeams(state);
  const teamEmbeds = teams.map((team, index) =>
    buildTeamDraftEmbed(team, index, team.captainKey === onClockCaptainKey, completedAt),
  );

  const embedBudget = MAX_EMBEDS_PER_MESSAGE - (state.memberPool.length > 0 ? 1 : 0);
  const cappedTeamEmbeds = teamEmbeds.slice(0, Math.max(embedBudget, 1));

  if (state.memberPool.length === 0) {
    return cappedTeamEmbeds;
  }

  return [...cappedTeamEmbeds, buildAvailablePoolEmbed(state.memberPool)];
}

/** @deprecated Use {@link buildLiveDraftEmbeds}. */
export function buildLiveDraftEmbed(state: DraftState, status: CaptainDraftStatus): EmbedBuilder {
  return buildLiveDraftEmbeds(state, status)[0]!;
}

export type LiveDraftMessagePayload = {
  content: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
};

/** Full live draft message: captain ping, per-team embeds, and pick button when active. */
export function buildLiveDraftMessage(
  draftId: string,
  state: DraftState,
  status: CaptainDraftStatus,
  completedAt?: Date,
): LiveDraftMessagePayload {
  return {
    content: buildLiveDraftContent(state, status),
    embeds: buildLiveDraftEmbeds(state, status, completedAt),
    components: buildLiveDraftComponents(draftId, status),
  };
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
