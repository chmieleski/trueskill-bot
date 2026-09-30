import type { Prisma } from '@dbz/db';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import {
  completeMatch,
  playersAffectingCancelledDisplay,
  resolveGrieferSlots,
  resolveQuitterSlots,
  type CompleteMatchResult,
} from './match-report.js';
import { getMatchById, MatchServiceError, type MatchWithPlayers } from './match-service.js';
import { ensurePlayerRatings } from '../rating/rating-preview.js';
import { recomputeDisplayCountersForPlayers } from '../rating/display-counters.js';

const log = createLogger('match-approval');

const matchWithPlayersInclude = {
  players: {
    include: { player: true },
    orderBy: { slot: 'asc' as const },
  },
} satisfies Prisma.MatchInclude;

function requireWaitingForApproval(match: MatchWithPlayers | null): MatchWithPlayers {
  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }

  if (match.status !== 'WAITING_FOR_APPROVAL') {
    throw new MatchServiceError('This match is not awaiting approval.');
  }

  return match;
}

/**
 * Persist the selected winning team while a match is WAITING_FOR_APPROVAL.
 */
export async function setApprovalWinner(
  matchId: string,
  winningTeam: 1 | 2,
): Promise<MatchWithPlayers> {
  requireWaitingForApproval(await getMatchById(matchId));

  await prisma.match.update({
    where: { id: matchId },
    data: { approvalWinnerTeam: winningTeam },
  });

  const updated = await getMatchById(matchId);
  log.info({ matchId, winningTeam }, 'Approval winner set');
  return updated!;
}

/**
 * Complete a waiting match using approvalWinnerTeam and current quitter/griefer flags.
 */
export async function approveWaitingMatch(matchId: string): Promise<CompleteMatchResult> {
  const match = requireWaitingForApproval(await getMatchById(matchId));

  if (match.approvalWinnerTeam !== 1 && match.approvalWinnerTeam !== 2) {
    throw new MatchServiceError('Set a winning team before approving this match.');
  }

  const winningTeam = match.approvalWinnerTeam;
  const quitterSlots = resolveQuitterSlots(match.players);
  const grieferSlots = resolveGrieferSlots(match.players);

  return completeMatch(matchId, winningTeam, quitterSlots, grieferSlots);
}

/**
 * Reject a waiting match: CANCELLED with no OpenSkill rating apply and no quitter penalties.
 * Display counters recompute only for players flagged quit/grief/DC.
 */
export async function rejectWaitingMatch(matchId: string): Promise<MatchWithPlayers> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Match"
      WHERE id = ${matchId} AND status = 'WAITING_FOR_APPROVAL'
      FOR UPDATE
    `;

    const locked = requireWaitingForApproval(
      await tx.match.findUnique({
        where: { id: matchId },
        include: matchWithPlayersInclude,
      }),
    );

    await tx.match.update({
      where: { id: locked.id },
      data: { status: 'CANCELLED' },
    });

    // CANCELLED only affects display via quit/grief/DC flags — skip clean rejects.
    if (locked.leagueId) {
      const affected = playersAffectingCancelledDisplay(locked.players);
      if (affected.length > 0) {
        await ensurePlayerRatings(
          locked.leagueId,
          affected.map((player) => ({ playerId: player.playerId, heroId: player.heroId })),
          tx,
        );
        await recomputeDisplayCountersForPlayers(
          locked.leagueId,
          affected.map((player) => player.playerId),
          tx,
        );
      }
    }
  });

  const updated = await getMatchById(matchId);
  log.info({ matchId }, 'Waiting match rejected');
  return updated!;
}
