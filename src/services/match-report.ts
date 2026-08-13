import { createLogger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import {
  getMatchById,
  MatchServiceError,
  type MatchWithPlayers,
} from './match-service.js';
import {
  applyMatchRatings,
  applyQuitterPenalties,
  assertBothTeamsHaveActivePlayers,
  type RatingRosterEntry,
} from './rating-update.js';

const log = createLogger('match-report');

function requireInProgress(match: MatchWithPlayers | null): MatchWithPlayers {
  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }

  if (match.status !== 'IN_PROGRESS') {
    throw new MatchServiceError('This match is not in progress.');
  }

  return match;
}

function toRatingEntries(
  match: MatchWithPlayers,
  quitterSlots: Set<number>,
): RatingRosterEntry[] {
  return match.players.map((player) => ({
    playerId: player.playerId,
    slot: player.slot,
    heroId: player.heroId,
    isQuitter: quitterSlots.has(player.slot),
  }));
}

function assertKnownQuitterSlots(match: MatchWithPlayers, quitterSlots: Set<number>): void {
  for (const slot of quitterSlots) {
    if (!match.players.some((player) => player.slot === slot)) {
      throw new MatchServiceError(`No player in slot ${slot}.`);
    }
  }
}

function isWinningSlot(slot: number, winningTeam: 1 | 2): boolean {
  return winningTeam === 1 ? slot <= 6 : slot > 6;
}

export async function setQuitters(
  matchId: string,
  quitterSlots: number[],
): Promise<MatchWithPlayers> {
  const match = requireInProgress(await getMatchById(matchId));
  const quitterSet = new Set(quitterSlots);

  assertKnownQuitterSlots(match, quitterSet);

  await prisma.$transaction(async (tx) => {
    const current = await tx.match.findUnique({
      where: { id: matchId },
      select: { status: true },
    });

    if (!current) {
      throw new MatchServiceError('This match was not found.');
    }

    if (current.status !== 'IN_PROGRESS') {
      throw new MatchServiceError('This match is not in progress.');
    }

    for (const player of match.players) {
      await tx.matchPlayer.update({
        where: { matchId_playerId: { matchId, playerId: player.playerId } },
        data: { isQuitter: quitterSet.has(player.slot) },
      });
    }
  });

  const updated = await getMatchById(matchId);
  log.info({ matchId, quitterSlots: [...quitterSet] }, 'Quitters updated');
  return updated!;
}

export async function completeMatch(
  matchId: string,
  winningTeam: 1 | 2,
  quitterSlots: number[],
): Promise<MatchWithPlayers> {
  const match = requireInProgress(await getMatchById(matchId));
  const quitterSet = new Set(quitterSlots);
  assertKnownQuitterSlots(match, quitterSet);

  const entries = toRatingEntries(match, quitterSet);
  const active = entries.filter((entry) => !entry.isQuitter);
  assertBothTeamsHaveActivePlayers(active);

  await prisma.$transaction(async (tx) => {
    const current = await tx.match.findUnique({
      where: { id: matchId },
      select: { status: true },
    });

    if (!current) {
      throw new MatchServiceError('This match was not found.');
    }

    if (current.status !== 'IN_PROGRESS') {
      throw new MatchServiceError('This match is not in progress.');
    }

    for (const player of match.players) {
      const isQuitter = quitterSet.has(player.slot);
      const won = !isQuitter && isWinningSlot(player.slot, winningTeam);

      await tx.matchPlayer.update({
        where: { matchId_playerId: { matchId, playerId: player.playerId } },
        data: {
          isQuitter,
          result: won ? 'WIN' : 'LOSS',
        },
      });
    }

    await applyQuitterPenalties(entries, tx);
    await applyMatchRatings(entries, winningTeam, tx);

    await tx.match.update({
      where: { id: matchId },
      data: { status: 'COMPLETED' },
    });
  });

  const updated = await getMatchById(matchId);
  log.info({ matchId, winningTeam, quitterSlots: [...quitterSet] }, 'Match completed');
  return updated!;
}

export async function cancelInProgressMatch(
  matchId: string,
): Promise<MatchWithPlayers> {
  const match = requireInProgress(await getMatchById(matchId));
  const quitterSlots = match.players.filter((player) => player.isQuitter).map((player) => player.slot);
  const entries = toRatingEntries(match, new Set(quitterSlots));

  await prisma.$transaction(async (tx) => {
    const current = await tx.match.findUnique({
      where: { id: matchId },
      select: { status: true },
    });

    if (!current) {
      throw new MatchServiceError('This match was not found.');
    }

    if (current.status !== 'IN_PROGRESS') {
      throw new MatchServiceError('This match is not in progress.');
    }

    if (quitterSlots.length > 0) {
      await applyQuitterPenalties(entries, tx);
    }

    await tx.match.update({
      where: { id: matchId },
      data: { status: 'CANCELLED' },
    });
  });

  const updated = await getMatchById(matchId);
  log.info({ matchId, quitterSlots }, 'In-progress match cancelled');
  return updated!;
}
