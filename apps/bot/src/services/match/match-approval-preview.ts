import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type Client,
  type TextChannel,
} from 'discord.js';
import { teamForSlot, type GameProfile } from '../../domain/game-profile.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { teamDisplayName, winnerLabel } from '../guild/team-names.js';
import { postCompletedMatchLog } from '../lobby/discord-sync.js';
import { buildMatchCancelledEmbed, buildMatchCompletedEmbed } from '../lobby/lobby-preview.js';
import type { LobbyRatingPreview } from '../rating/rating-preview.js';
import {
  getGameProfileForMatch,
  getMatchById,
  matchToLobbyPlayers,
  MatchServiceError,
  type MatchWithPlayers,
} from './match-service.js';

const log = createLogger('match-approval-preview');

const TEAM_A_EMOJI = '🟥';
const TEAM_B_EMOJI = '🟦';

export const MATCH_APPROVAL_CUSTOM_ID_PREFIX = 'match:ap:';

export type MatchApprovalAction =
  | { kind: 'quitters'; matchId: string }
  | { kind: 'griefers'; matchId: string }
  | { kind: 'winner'; matchId: string }
  | { kind: 'win'; matchId: string; winningTeam: 1 | 2 }
  | { kind: 'approve'; matchId: string }
  | { kind: 'reject'; matchId: string }
  | { kind: 'qset'; matchId: string }
  | { kind: 'gset'; matchId: string }
  | { kind: 'qok'; matchId: string; slots: number[] }
  | { kind: 'gok'; matchId: string; slots: number[] };

/** Encode sorted unique slots for compact custom ids (`-` when empty). */
export function encodeApprovalSlots(slots: number[]): string {
  const normalized = [...new Set(slots)].sort((a, b) => a - b);
  return normalized.length > 0 ? normalized.join('-') : '-';
}

/** Decode slot csv from approval custom ids. */
export function decodeApprovalSlots(slotsCsv: string | undefined): number[] {
  if (!slotsCsv || slotsCsv === '-') {
    return [];
  }

  return slotsCsv
    .split('-')
    .map((slot) => Number(slot))
    .filter((slot) => Number.isInteger(slot));
}

export function buildApprovalQuittersCustomId(matchId: string): string {
  return `match:ap:quitters:${matchId}`;
}

export function buildApprovalGriefersCustomId(matchId: string): string {
  return `match:ap:griefers:${matchId}`;
}

export function buildApprovalWinnerCustomId(matchId: string): string {
  return `match:ap:winner:${matchId}`;
}

export function buildApprovalWinCustomId(matchId: string, winningTeam: 1 | 2): string {
  return `match:ap:win:${matchId}:${winningTeam}`;
}

export function buildApprovalApproveCustomId(matchId: string): string {
  return `match:ap:approve:${matchId}`;
}

export function buildApprovalRejectCustomId(matchId: string): string {
  return `match:ap:reject:${matchId}`;
}

export function buildApprovalQuitterSelectCustomId(matchId: string): string {
  return `match:ap:qset:${matchId}`;
}

export function buildApprovalGrieferSelectCustomId(matchId: string): string {
  return `match:ap:gset:${matchId}`;
}

export function buildApprovalQuitterKeepCustomId(matchId: string, slots: number[]): string {
  return `match:ap:qok:${matchId}:${encodeApprovalSlots(slots)}`;
}

export function buildApprovalGrieferKeepCustomId(matchId: string, slots: number[]): string {
  return `match:ap:gok:${matchId}:${encodeApprovalSlots(slots)}`;
}

/**
 * Parse a `match:ap:*` custom id into a typed action, or null when malformed.
 */
export function parseMatchApprovalCustomId(customId: string): MatchApprovalAction | null {
  if (!customId.startsWith(MATCH_APPROVAL_CUSTOM_ID_PREFIX)) {
    return null;
  }

  const parts = customId.split(':');
  if (parts.length < 4 || parts[0] !== 'match' || parts[1] !== 'ap') {
    return null;
  }

  const action = parts[2];
  const matchId = parts[3];
  if (!matchId) {
    return null;
  }

  switch (action) {
    case 'quitters':
    case 'griefers':
    case 'winner':
    case 'approve':
    case 'reject':
    case 'qset':
    case 'gset':
      if (parts.length !== 4) {
        return null;
      }
      return { kind: action, matchId };
    case 'win': {
      if (parts.length !== 5) {
        return null;
      }
      const teamRaw = parts[4];
      if (teamRaw !== '1' && teamRaw !== '2') {
        return null;
      }
      return { kind: 'win', matchId, winningTeam: Number(teamRaw) as 1 | 2 };
    }
    case 'qok':
    case 'gok': {
      if (parts.length !== 5) {
        return null;
      }
      return { kind: action, matchId, slots: decodeApprovalSlots(parts[4]) };
    }
    default:
      return null;
  }
}

type ApprovalPlayer = MatchWithPlayers['players'][number];

function sortedPlayers(match: MatchWithPlayers): ApprovalPlayer[] {
  return [...match.players].sort((a, b) => a.slot - b.slot);
}

function formatApprovalRosterLine(player: ApprovalPlayer): string {
  const marks: string[] = [];
  if (player.isQuitter) {
    marks.push('🚪');
  }
  if (player.isGriefer) {
    marks.push('🐛');
  }
  const suffix = marks.length > 0 ? ` ${marks.join(' ')}` : '';
  return `**${player.slot}.** ${player.player.username}${suffix}`;
}

function formatTeamRoster(
  match: MatchWithPlayers,
  team: 1 | 2,
  profile: GameProfile,
): { value: string; count: number } {
  const players = sortedPlayers(match).filter(
    (player) => teamForSlot(profile, player.slot) === team,
  );
  if (players.length === 0) {
    return { value: '_Empty_', count: 0 };
  }
  return {
    value: players.map(formatApprovalRosterLine).join('\n'),
    count: players.length,
  };
}

/**
 * Waiting-for-approval embed: teams, quit/grief marks, winner, externalId, match id.
 */
export function buildMatchApprovalEmbed(
  match: MatchWithPlayers,
  options: {
    profile: GameProfile;
    externalId?: string | null;
  },
): EmbedBuilder {
  const profile = options.profile;
  const teamA = formatTeamRoster(match, 1, profile);
  const teamB = formatTeamRoster(match, 2, profile);
  const winnerTeam =
    match.approvalWinnerTeam === 1 || match.approvalWinnerTeam === 2
      ? match.approvalWinnerTeam
      : null;
  const winnerText = winnerTeam ? `**${winnerLabel(winnerTeam, profile)}**` : '_not set_';
  const externalId = options.externalId?.trim() || null;

  const embed = new EmbedBuilder()
    .setTitle('Match Awaiting Approval')
    .setDescription(
      'Match moderators can edit quitters, griefers, and winner, then approve or reject.',
    )
    .addFields(
      {
        name: `${TEAM_A_EMOJI} ${teamDisplayName(1, profile)} (${teamA.count})`,
        value: teamA.value,
        inline: false,
      },
      {
        name: `${TEAM_B_EMOJI} ${teamDisplayName(2, profile)} (${teamB.count})`,
        value: teamB.value,
        inline: false,
      },
      {
        name: 'Winner',
        value: winnerText,
        inline: true,
      },
      {
        name: 'Report ID',
        value: externalId ? `\`${externalId}\`` : '_none_',
        inline: true,
      },
    )
    .setColor(0xfaa61a)
    .setAuthor({ name: `Match ${match.id}` })
    .setTimestamp(match.createdAt);

  return embed;
}

/** Primary action row for the approval channel message. */
export function buildMatchApprovalButtons(matchId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildApprovalQuittersCustomId(matchId))
        .setLabel('Quitters')
        .setEmoji('🚪')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(buildApprovalGriefersCustomId(matchId))
        .setLabel('Griefers')
        .setEmoji('🐛')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(buildApprovalWinnerCustomId(matchId))
        .setLabel('Set Winner')
        .setEmoji('🏆')
        .setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildApprovalApproveCustomId(matchId))
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(buildApprovalRejectCustomId(matchId))
        .setLabel('Reject')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/** Ephemeral winner team buttons. */
export function buildMatchApprovalWinnerButtons(
  matchId: string,
  profile: GameProfile,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildApprovalWinCustomId(matchId, 1))
      .setLabel(`${winnerLabel(1, profile)} Won`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(buildApprovalWinCustomId(matchId, 2))
      .setLabel(`${winnerLabel(2, profile)} Won`)
      .setStyle(ButtonStyle.Primary),
  );
}

/** Quitter multi-select for approval edits. */
export function buildMatchApprovalQuitterSelect(
  match: MatchWithPlayers,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = sortedPlayers(match).map((player) => ({
    label: `Slot ${player.slot}: ${player.player.username}`.slice(0, 100),
    value: String(player.slot),
    default: player.isQuitter,
  }));

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildApprovalQuitterSelectCustomId(match.id))
      .setPlaceholder('Select players who quit')
      .setMinValues(0)
      .setMaxValues(options.length)
      .addOptions(options),
  );
}

/** Griefer multi-select for approval edits. */
export function buildMatchApprovalGrieferSelect(
  match: MatchWithPlayers,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = sortedPlayers(match).map((player) => ({
    label: `Slot ${player.slot}: ${player.player.username}`.slice(0, 100),
    value: String(player.slot),
    default: player.isGriefer,
  }));

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildApprovalGrieferSelectCustomId(match.id))
      .setPlaceholder('Select griefers (bug abuse)')
      .setMinValues(0)
      .setMaxValues(options.length)
      .addOptions(options),
  );
}

/**
 * Discord does not fire a select when defaults are left unchanged — offer Save selected.
 */
export function buildMatchApprovalQuitterKeepRow(
  matchId: string,
  quitterSlots: number[],
): ActionRowBuilder<ButtonBuilder> | null {
  if (quitterSlots.length === 0) {
    return null;
  }
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildApprovalQuitterKeepCustomId(matchId, quitterSlots))
      .setLabel('Save selected')
      .setStyle(ButtonStyle.Primary),
  );
}

export function buildMatchApprovalGrieferKeepRow(
  matchId: string,
  grieferSlots: number[],
): ActionRowBuilder<ButtonBuilder> | null {
  if (grieferSlots.length === 0) {
    return null;
  }
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildApprovalGrieferKeepCustomId(matchId, grieferSlots))
      .setLabel('Save selected')
      .setStyle(ButtonStyle.Primary),
  );
}

/** Terminal completed view (no action buttons). */
export function buildMatchApprovalCompletedMessage(
  match: MatchWithPlayers,
  options: {
    profile: GameProfile;
    ratingPreview: LobbyRatingPreview;
    winningTeam: 1 | 2;
  },
): { embeds: EmbedBuilder[]; components: [] } {
  return {
    embeds: [
      buildMatchCompletedEmbed(match.id, matchToLobbyPlayers(match), {
        ratingPreview: options.ratingPreview,
        winningTeam: options.winningTeam,
        profile: options.profile,
        timestamp: match.completedAt ?? new Date(),
      }),
    ],
    components: [],
  };
}

/** Terminal cancelled view (no action buttons). */
export function buildMatchApprovalCancelledMessage(
  match: MatchWithPlayers,
  reason: string,
): { embeds: EmbedBuilder[]; components: [] } {
  return {
    embeds: [buildMatchCancelledEmbed(match.id, reason)],
    components: [],
  };
}

/** Load report externalId for the approval embed, if present. */
export async function loadApprovalExternalId(matchId: string): Promise<string | null> {
  const report = await prisma.matchStatsReport.findUnique({
    where: { matchId },
    select: { externalId: true },
  });
  return report?.externalId ?? null;
}

async function fetchSendableTextChannel(client: Client, channelId: string): Promise<TextChannel> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    throw new MatchServiceError('Match approval channel is missing or not a text channel.');
  }
  return channel as TextChannel;
}

/**
 * Refresh the channel approval message after an edit / approve / reject.
 */
export async function syncMatchApprovalMessage(
  client: Client,
  match: MatchWithPlayers,
  mode: 'waiting' | 'completed' | 'cancelled',
  options: {
    ratingPreview?: LobbyRatingPreview;
    winningTeam?: 1 | 2;
    cancelReason?: string;
    postToMatchLog?: boolean;
  } = {},
): Promise<void> {
  if (!match.discordMessageId || !match.discordChannelId) {
    log.warn({ matchId: match.id, mode }, 'Approval match has no Discord message to sync');
    return;
  }

  const channel = await fetchSendableTextChannel(client, match.discordChannelId);
  const profile = await getGameProfileForMatch(match);

  let payload: { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] | [] };

  if (mode === 'waiting') {
    const externalId = await loadApprovalExternalId(match.id);
    payload = {
      embeds: [buildMatchApprovalEmbed(match, { profile, externalId })],
      components: buildMatchApprovalButtons(match.id),
    };
  } else if (mode === 'completed') {
    const winningTeam =
      options.winningTeam ??
      (match.approvalWinnerTeam === 1 || match.approvalWinnerTeam === 2
        ? match.approvalWinnerTeam
        : 1);
    payload = buildMatchApprovalCompletedMessage(match, {
      profile,
      ratingPreview: options.ratingPreview ?? { players: [] },
      winningTeam,
    });
  } else {
    payload = buildMatchApprovalCancelledMessage(
      match,
      options.cancelReason ?? 'rejected by a moderator',
    );
  }

  await channel.messages.edit(match.discordMessageId, payload);
  log.debug({ matchId: match.id, mode }, 'Approval Discord message synced');

  if (options.postToMatchLog && (mode === 'completed' || mode === 'cancelled')) {
    await postCompletedMatchLog(client, match, payload, {
      enrichStats: mode === 'completed',
    });
  }
}

/**
 * Post the initial approval embed+buttons to the league approval channel.
 */
export async function postMatchApprovalMessage(
  client: Client,
  input: { guildId: string; channelId: string; matchId: string },
): Promise<{ messageId: string; messageUrl: string }> {
  const match = await getMatchById(input.matchId);
  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }
  if (match.status !== 'WAITING_FOR_APPROVAL') {
    throw new MatchServiceError('This match is not awaiting approval.');
  }

  const channelId = input.channelId.trim();
  if (channelId === '') {
    throw new MatchServiceError('Match approval channel is not configured.');
  }

  const channel = await fetchSendableTextChannel(client, channelId);
  const profile = await getGameProfileForMatch(match);
  const externalId = await loadApprovalExternalId(match.id);

  const message = await channel.send({
    embeds: [buildMatchApprovalEmbed(match, { profile, externalId })],
    components: buildMatchApprovalButtons(match.id),
  });

  const messageUrl = `https://discord.com/channels/${input.guildId}/${channelId}/${message.id}`;
  log.info(
    { matchId: match.id, channelId, messageId: message.id },
    'Approval Discord message posted',
  );

  return { messageId: message.id, messageUrl };
}
