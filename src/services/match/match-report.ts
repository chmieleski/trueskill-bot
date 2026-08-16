import type { Prisma } from '@prisma/client';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import {
  getMatchById,
  MatchServiceError,
  type MatchWithPlayers,
} from './match-service.js';
import {
  buildCompletedRatingPreview,
  ensurePlayerRatings,
  loadPlayerKiBySlot,
  matchPlayersToRatingEntries,
  type LobbyRatingPreview,
} from '../rating/rating-preview.js';
import {
  applyMatchRatings,
  applyQuitterPenalties,
  assertBothTeamsHaveActivePlayers,
  type RatingRosterEntry,
} from '../rating/rating-update.js';
import { writeMatchRatingSnapshots } from './match-correction.js';

const log = createLogger('match-report');

const matchWithPlayersInclude = {
  players: {
    include: { player: true },
    orderBy: { slot: 'asc' },
  },
} satisfies Prisma.MatchInclude;

export type CompleteMatchResult = {
  match: MatchWithPlayers;
  ratingPreview: LobbyRatingPreview;
};

function requireInProgress(match: MatchWithPlayers | null): MatchWithPlayers {
  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }

  if (match.status !== 'IN_PROGRESS') {
    throw new MatchServiceError('This match is not in progress.');
  }

  return match;
}

async function lockInProgressMatch(
  tx: Prisma.TransactionClient,
  matchId: string,
): Promise<MatchWithPlayers> {
  await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Match"
    WHERE id = ${matchId} AND status = 'IN_PROGRESS'
    FOR UPDATE
  `;

  return requireInProgress(
    await tx.match.findUnique({
      where: { id: matchId },
      include: matchWithPlayersInclude,
    }),
  );
}

function normalizeSlots(slots: number[]): number[] {
  return [...new Set(slots)].sort((a, b) => a - b);
}

export function resolveQuitterSlots(
  persistedFlags: Pick<MatchWithPlayers['players'][number], 'slot' | 'isQuitter'>[],
  quitterSlots?: number[],
): number[] {
  if (quitterSlots !== undefined) {
    return normalizeSlots(quitterSlots);
  }

  return normalizeSlots(
    persistedFlags.filter((player) => player.isQuitter).map((player) => player.slot),
  );
}

function toRatingEntries(
  match: MatchWithPlayers,
  quitterSlots: Set<number>,
): RatingRosterEntry[] {
  return match.players.map((player) => ({
    playerId: player.playerId,
    slot: player.slot,
    team: player.team as 1 | 2,
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

function isWinningTeam(team: number, winningTeam: 1 | 2): boolean {
  return team === winningTeam;
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
  quitterSlots?: number[],
): Promise<CompleteMatchResult> {
  let resolvedQuitterSlots: number[] = [];
  let ratingPreview: LobbyRatingPreview = { players: [] };

  await prisma.$transaction(async (tx) => {
    const match = await lockInProgressMatch(tx, matchId);
    resolvedQuitterSlots = resolveQuitterSlots(match.players, quitterSlots);
    const quitterSet = new Set(resolvedQuitterSlots);
    assertKnownQuitterSlots(match, quitterSet);

    const entries = toRatingEntries(match, quitterSet);
    const active = entries.filter((entry) => !entry.isQuitter);
    assertBothTeamsHaveActivePlayers(active);

    const previewEntries = matchPlayersToRatingEntries(
      match.players.map((player) => ({
        ...player,
        isQuitter: quitterSet.has(player.slot),
      })),
    );

    const beforeBySlot = await loadPlayerKiBySlot(match.leagueId, previewEntries, tx);

    await ensurePlayerRatings(
      match.leagueId,
      match.players.map((p) => ({ playerId: p.playerId, heroId: p.heroId })),
      tx,
    );
    await writeMatchRatingSnapshots(
      match.leagueId,
      matchId,
      match.players.map((p) => ({ playerId: p.playerId, heroId: p.heroId })),
      tx,
    );

    for (const player of match.players) {
      const isQuitter = quitterSet.has(player.slot);
      const won = !isQuitter && isWinningTeam(player.team, winningTeam);

      await tx.matchPlayer.update({
        where: { matchId_playerId: { matchId, playerId: player.playerId } },
        data: {
          isQuitter,
          result: won ? 'WIN' : 'LOSS',
        },
      });
    }

    await applyQuitterPenalties(match.leagueId, entries, tx);
    await applyMatchRatings(match.leagueId, entries, winningTeam, tx);

    await tx.match.update({
      where: { id: matchId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    const afterBySlot = await loadPlayerKiBySlot(match.leagueId, previewEntries, tx);
    ratingPreview = buildCompletedRatingPreview(
      previewEntries,
      beforeBySlot,
      afterBySlot,
    );
  });

  const updated = await getMatchById(matchId);
  log.info({ matchId, winningTeam, quitterSlots: resolvedQuitterSlots }, 'Match completed');
  return { match: updated!, ratingPreview };
}

export async function cancelInProgressMatch(
  matchId: string,
): Promise<MatchWithPlayers> {
  let quitterSlots: number[] = [];

  await prisma.$transaction(async (tx) => {
    const match = await lockInProgressMatch(tx, matchId);
    quitterSlots = resolveQuitterSlots(match.players);
    const entries = toRatingEntries(match, new Set(quitterSlots));

    if (quitterSlots.length > 0) {
      await applyQuitterPenalties(match.leagueId, entries, tx);
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
