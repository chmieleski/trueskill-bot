import { EmbedBuilder } from 'discord.js';
import type { DraftParticipant, DraftState, DraftTeam } from './draft-types.js';

/** Leaderboard-style gold accent. */
export const RANK_GOLD = 0xf0b232;

/** Rotating embed colors for published team rosters. */
export const TEAM_EMBED_COLORS: number[] = [
  RANK_GOLD,
  0x3498db,
  0xe74c3c,
  0x2ecc71,
  0x9b59b6,
  0xe67e22,
  0x1abc9c,
  0x95a5a6,
];

/** Render a participant as a Discord mention or plain label. */
export function formatParticipantDisplay(participant: DraftParticipant): string {
  return participant.discordId ? `<@${participant.discordId}>` : participant.label;
}

/** Bullet roster list; captain row marked with 👑 (mentions render outside code blocks). */
export function formatTeamRosterList(team: DraftTeam): string {
  if (team.roster.length === 0) {
    return '_Empty roster_';
  }

  return team.roster
    .map((player) => {
      const display = formatParticipantDisplay(player);
      const crown = player.key === team.captainKey ? ' 👑' : '';
      return `- ${display}${crown}`;
    })
    .join('\n');
}

/** @deprecated Use {@link formatTeamRosterList}; kept as alias for existing imports. */
export const formatTeamRosterTable = formatTeamRosterList;

function formatDraftDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Build one leaderboard-style embed per team; footer only on the final team. */
export function buildTeamRosterEmbeds(state: DraftState, completedAt: Date): EmbedBuilder[] {
  const sortedTeams = [...state.teams].sort((a, b) => a.pickOrderIndex - b.pickOrderIndex);
  const dateLabel = formatDraftDate(completedAt);
  const lastIndex = sortedTeams.length - 1;

  return sortedTeams.map((team, index) => {
    const captain = team.roster.find((player) => player.key === team.captainKey) ?? team.roster[0];
    const color = TEAM_EMBED_COLORS[index % TEAM_EMBED_COLORS.length]!;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(team.displayName)
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
          value: formatTeamRosterList(team),
        },
      )
      .setFooter({ text: 'Captain draft' })
      .setTimestamp(completedAt);

    if (index === lastIndex) {
      embed.setFooter({
        text: `Captain draft · ${dateLabel} · Pick order #${team.pickOrderIndex + 1}`,
      });
    }

    return embed;
  });
}
