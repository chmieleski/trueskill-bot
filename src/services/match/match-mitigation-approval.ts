import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client } from 'discord.js';
import type { Prisma } from '@prisma/client';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { getMatchById, MatchServiceError, type MatchWithPlayers } from './match-service.js';
import {
  completeMatch,
  resolveGrieferSlots,
  resolveQuitterSlots,
  type CompleteMatchResult,
} from './match-report.js';
import {
  normalizeMitigationPercent,
  RATING_MITIGATION_PERCENTS,
  type RatingMitigationInput,
  type RatingMitigationPercent,
} from '../rating/rating-mitigation.js';

const log = createLogger('match-mitigation-approval');

export const MITIGATION_APPROVAL_CUSTOM_ID_PREFIX = 'match:mit:';

const matchWithPlayersInclude = {
  players: {
    include: { player: true },
    orderBy: { slot: 'asc' as const },
  },
} satisfies Prisma.MatchInclude;

function requireMitigationWaiting(match: MatchWithPlayers | null): MatchWithPlayers {
  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }
  if (match.status !== 'WAITING_FOR_MITIGATION_APPROVAL') {
    throw new MatchServiceError('This match is not awaiting mitigation approval.');
  }
  return match;
}

/** Build custom id for lobby-channel mitigation approval buttons. */
export function buildMitigationApprovalCustomId(
  action: 'approve' | 'reject' | 'set',
  matchId: string,
  percent?: RatingMitigationInput,
): string {
  if (action === 'set') {
    return `${MITIGATION_APPROVAL_CUSTOM_ID_PREFIX}set:${matchId}:${percent ?? 0}`;
  }
  return `${MITIGATION_APPROVAL_CUSTOM_ID_PREFIX}${action}:${matchId}`;
}

export function parseMitigationApprovalCustomId(customId: string): {
  action: 'approve' | 'reject' | 'set';
  matchId: string;
  percent?: RatingMitigationInput;
} | null {
  if (!customId.startsWith(MITIGATION_APPROVAL_CUSTOM_ID_PREFIX)) {
    return null;
  }
  const parts = customId.split(':');
  // match:mit:approve:id | match:mit:reject:id | match:mit:set:id:pct
  if (parts.length < 4 || parts[0] !== 'match' || parts[1] !== 'mit') {
    return null;
  }
  const action = parts[2];
  const matchId = parts[3];
  if (!matchId || (action !== 'approve' && action !== 'reject' && action !== 'set')) {
    return null;
  }
  if (action === 'set') {
    const pct = normalizeMitigationPercent(Number(parts[4]));
    return { action, matchId, percent: pct };
  }
  return { action, matchId };
}

export function buildMitigationApprovalComponents(
  matchId: string,
  selectedPercent: RatingMitigationInput,
): ActionRowBuilder<ButtonBuilder>[] {
  const presetRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildMitigationApprovalCustomId('set', matchId, 0))
      .setLabel(selectedPercent === 0 ? 'None ✓' : 'None')
      .setStyle(selectedPercent === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ...RATING_MITIGATION_PERCENTS.map((pct) =>
      new ButtonBuilder()
        .setCustomId(buildMitigationApprovalCustomId('set', matchId, pct))
        .setLabel(selectedPercent === pct ? `${pct}% ✓` : `${pct}%`)
        .setStyle(selectedPercent === pct ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildMitigationApprovalCustomId('approve', matchId))
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(buildMitigationApprovalCustomId('reject', matchId))
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
  );

  return [presetRow, actionRow];
}

export function formatMitigationApprovalContent(input: {
  matchId: string;
  winnerLabel: string;
  mitigationPercent: RatingMitigationInput;
  quitterSummary: string;
  grieferSummary: string;
  requestedByTag: string;
}): string {
  const mitLine =
    input.mitigationPercent > 0
      ? `Mitigation: **${input.mitigationPercent}%** (both sides keep ${100 - input.mitigationPercent}% of team ki Δ)`
      : 'Mitigation: **none** (full strength)';

  return [
    `**Mitigation approval** for match \`${input.matchId}\``,
    `Requested by ${input.requestedByTag}`,
    `Winner: **${input.winnerLabel}**`,
    mitLine,
    input.grieferSummary,
    input.quitterSummary,
    '',
    'Mods: adjust mitigation if needed, then **Approve** or **Reject**.',
  ].join('\n');
}

export type RequestMitigationApprovalInput = {
  matchId: string;
  winningTeam: 1 | 2;
  quitterSlots: number[];
  grieferSlots: number[];
  mitigationPercent: RatingMitigationPercent;
  client: Client;
  requestedByTag: string;
  winnerLabel: string;
  quitterSummary: string;
  grieferSummary: string;
};

/**
 * Persist host soft-result request and post mod Approve/Reject/Edit in the lobby channel.
 */
export async function requestMitigationApproval(
  input: RequestMitigationApprovalInput,
): Promise<MatchWithPlayers> {
  const mitigation = normalizeMitigationPercent(input.mitigationPercent);
  if (mitigation === 0) {
    throw new MatchServiceError('Mitigation approval requires a non-zero mitigation percent.');
  }

  const match = await getMatchById(input.matchId);
  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }
  if (match.status !== 'IN_PROGRESS') {
    throw new MatchServiceError('This match is not in progress.');
  }

  const quitterSet = new Set(input.quitterSlots);
  const grieferSet = new Set(input.grieferSlots);

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Match"
      WHERE id = ${input.matchId} AND status = 'IN_PROGRESS'
      FOR UPDATE
    `;

    for (const player of match.players) {
      const isQuitter = quitterSet.has(player.slot);
      const isGriefer = grieferSet.has(player.slot);
      await tx.matchPlayer.update({
        where: { matchId_playerId: { matchId: input.matchId, playerId: player.playerId } },
        data: {
          isQuitter,
          isGriefer: isQuitter ? false : isGriefer,
        },
      });
    }

    await tx.match.update({
      where: { id: input.matchId },
      data: {
        status: 'WAITING_FOR_MITIGATION_APPROVAL',
        approvalWinnerTeam: input.winningTeam,
        ratingMitigationPercent: mitigation,
      },
    });
  });

  const content = formatMitigationApprovalContent({
    matchId: input.matchId,
    winnerLabel: input.winnerLabel,
    mitigationPercent: mitigation,
    quitterSummary: input.quitterSummary,
    grieferSummary: input.grieferSummary,
    requestedByTag: input.requestedByTag,
  });

  const channel = await input.client.channels.fetch(match.discordChannelId);
  if (!channel || !('send' in channel) || typeof channel.send !== 'function') {
    throw new MatchServiceError('Could not post mitigation approval in the match channel.');
  }

  const message = await channel.send({
    content,
    components: buildMitigationApprovalComponents(input.matchId, mitigation),
  });

  await prisma.match.update({
    where: { id: input.matchId },
    data: { mitigationApprovalMessageId: message.id },
  });

  log.info(
    { matchId: input.matchId, mitigationPercent: mitigation, messageId: message.id },
    'Mitigation approval requested',
  );

  const updated = await getMatchById(input.matchId);
  return updated!;
}

/**
 * Change pending mitigation percent (including clearing to none) while awaiting approval.
 */
export async function setPendingMitigationPercent(
  matchId: string,
  percent: RatingMitigationInput,
): Promise<MatchWithPlayers> {
  const mitigation = normalizeMitigationPercent(percent);
  requireMitigationWaiting(await getMatchById(matchId));

  await prisma.match.update({
    where: { id: matchId },
    data: { ratingMitigationPercent: mitigation > 0 ? mitigation : null },
  });

  const updated = await getMatchById(matchId);
  log.info({ matchId, mitigationPercent: mitigation }, 'Pending mitigation updated');
  return updated!;
}

/**
 * Mod approves a pending mitigation request and completes the match.
 */
export async function approveMitigationMatch(matchId: string): Promise<CompleteMatchResult> {
  const match = requireMitigationWaiting(await getMatchById(matchId));

  if (match.approvalWinnerTeam !== 1 && match.approvalWinnerTeam !== 2) {
    throw new MatchServiceError('Set a winning team before approving this match.');
  }

  const winningTeam = match.approvalWinnerTeam;
  const quitterSlots = resolveQuitterSlots(match.players);
  const grieferSlots = resolveGrieferSlots(match.players);
  const mitigation = normalizeMitigationPercent(match.ratingMitigationPercent);

  return completeMatch(matchId, winningTeam, quitterSlots, grieferSlots, mitigation);
}

/**
 * Mod rejects a pending mitigation request; match returns to IN_PROGRESS.
 */
export async function rejectMitigationMatch(matchId: string): Promise<MatchWithPlayers> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Match"
      WHERE id = ${matchId} AND status = 'WAITING_FOR_MITIGATION_APPROVAL'
      FOR UPDATE
    `;

    const locked = requireMitigationWaiting(
      await tx.match.findUnique({
        where: { id: matchId },
        include: matchWithPlayersInclude,
      }),
    );

    await tx.match.update({
      where: { id: locked.id },
      data: {
        status: 'IN_PROGRESS',
        approvalWinnerTeam: null,
        ratingMitigationPercent: null,
        mitigationApprovalMessageId: null,
      },
    });
  });

  const updated = await getMatchById(matchId);
  log.info({ matchId }, 'Mitigation approval rejected');
  return updated!;
}
