import type { Prisma } from '@prisma/client';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import {
  getMatchById,
  isEventMatch,
  MatchServiceError,
  requireLeagueId,
  type MatchWithPlayers,
} from './match-service.js';
import {
  buildCompletedRatingPreview,
  ensurePlayerRatings,
  loadPlayerKiBySlot,
  loadRosterWinChance,
  matchPlayersToRatingEntries,
  type LobbyRatingPreview,
} from '../rating/rating-preview.js';
import { assertTeam } from '../../domain/game-profile.js';
import {
  accrueGrieferPenalties,
  applyMatchRatings,
  applyQuitterPenalties,
  assertBothTeamsHaveActivePlayers,
  loadLiveGlobalByPlayer,
  loadPreMatchGlobalByPlayer,
  type RatingRosterEntry,
} from '../rating/rating-update.js';
import { writeMatchRatingSnapshots } from './match-correction.js';
import { persistMatchRatingPreviewToPlayers } from './match-history-preview.js';
import {
  gamesByPlayerFromStats,
  loadMatchDisplayStatsByPlayer,
} from '../rating/rank-reset-display.js';
import { loadIsNewPlayerByPlayerId, playerIdsToClearNewFlag } from '../rating/new-player.js';

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

export function resolveGrieferSlots(
  persistedFlags: Pick<MatchWithPlayers['players'][number], 'slot' | 'isGriefer'>[],
  grieferSlots?: number[],
): number[] {
  if (grieferSlots !== undefined) {
    return normalizeSlots(grieferSlots);
  }

  return normalizeSlots(
    persistedFlags.filter((player) => player.isGriefer).map((player) => player.slot),
  );
}

function toRatingEntries(
  match: MatchWithPlayers,
  quitterSlots: Set<number>,
  grieferSlots: Set<number>,
  wasNewByPlayerId?: Map<string, boolean>,
): RatingRosterEntry[] {
  return match.players.map((player) => ({
    playerId: player.playerId,
    slot: player.slot,
    team: assertTeam(player.team),
    heroId: player.heroId,
    isQuitter: quitterSlots.has(player.slot),
    isGriefer: grieferSlots.has(player.slot),
    wasNewPlayer: wasNewByPlayerId?.get(player.playerId) === true,
  }));
}

function assertKnownSlots(match: MatchWithPlayers, slots: Set<number>, label: string): void {
  for (const slot of slots) {
    if (!match.players.some((player) => player.slot === slot)) {
      throw new MatchServiceError(`No ${label} player in slot ${slot}.`);
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

  assertKnownSlots(match, quitterSet, 'quitter');

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
      await tx.matchPlayer.update({
        where: { matchId_playerId: { matchId, playerId: player.playerId } },
        data: {
          isQuitter,
          ...(isQuitter ? { isGriefer: false } : {}),
        },
      });
    }
  });

  const updated = await getMatchById(matchId);
  log.info({ matchId, quitterSlots: [...quitterSet] }, 'Quitters updated');
  return updated!;
}

export async function setGriefers(
  matchId: string,
  grieferSlots: number[],
): Promise<MatchWithPlayers> {
  const match = requireInProgress(await getMatchById(matchId));
  const grieferSet = new Set(grieferSlots);

  assertKnownSlots(match, grieferSet, 'griefer');

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
      const isGriefer = grieferSet.has(player.slot);
      await tx.matchPlayer.update({
        where: { matchId_playerId: { matchId, playerId: player.playerId } },
        data: {
          isGriefer,
          grieferKiAccrued: isGriefer ? undefined : null,
          ...(isGriefer ? { isQuitter: false } : {}),
        },
      });
    }
  });

  const updated = await getMatchById(matchId);
  log.info({ matchId, grieferSlots: [...grieferSet] }, 'Griefers updated');
  return updated!;
}

export async function completeMatch(
  matchId: string,
  winningTeam: 1 | 2,
  quitterSlots?: number[],
  grieferSlots?: number[],
): Promise<CompleteMatchResult> {
  let resolvedQuitterSlots: number[] = [];
  let resolvedGrieferSlots: number[] = [];
  let ratingPreview: LobbyRatingPreview = { players: [] };

  await prisma.$transaction(async (tx) => {
    const match = await lockInProgressMatch(tx, matchId);
    resolvedQuitterSlots = resolveQuitterSlots(match.players, quitterSlots);
    resolvedGrieferSlots = resolveGrieferSlots(match.players, grieferSlots);
    const quitterSet = new Set(resolvedQuitterSlots);
    const grieferSet = new Set(resolvedGrieferSlots);
    assertKnownSlots(match, quitterSet, 'quitter');
    assertKnownSlots(match, grieferSet, 'griefer');

    const activeForTeams = match.players
      .filter((p) => !quitterSet.has(p.slot))
      .map((p) => ({ slot: p.slot, team: assertTeam(p.team) }));
    assertBothTeamsHaveActivePlayers(activeForTeams);

    // Event matches: roster/results only — no OpenSkill or IHL side effects.
    if (isEventMatch(match)) {
      for (const player of match.players) {
        const isQuitter = quitterSet.has(player.slot);
        const won = !isQuitter && isWinningTeam(player.team, winningTeam);

        await tx.matchPlayer.update({
          where: { matchId_playerId: { matchId, playerId: player.playerId } },
          data: {
            isQuitter,
            isGriefer: grieferSet.has(player.slot),
            result: won ? 'WIN' : 'LOSS',
            wasNewPlayer: false,
          },
        });
      }

      await tx.match.update({
        where: { id: matchId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      ratingPreview = { players: [] };
      return;
    }

    const leagueId = requireLeagueId(match);

    const previewEntries = matchPlayersToRatingEntries(
      match.players.map((player) => ({
        ...player,
        isQuitter: quitterSet.has(player.slot),
        isGriefer: grieferSet.has(player.slot),
      })),
    );

    const beforeBySlot = await loadPlayerKiBySlot(leagueId, previewEntries, tx);

    await ensurePlayerRatings(
      leagueId,
      match.players.map((p) => ({ playerId: p.playerId, heroId: p.heroId })),
      tx,
    );
    const playerIds = match.players.map((p) => p.playerId);
    const isNewByPlayerId = await loadIsNewPlayerByPlayerId(leagueId, playerIds, tx);
    const entries = toRatingEntries(match, quitterSet, grieferSet, isNewByPlayerId);
    const active = entries.filter((entry) => !entry.isQuitter);
    assertBothTeamsHaveActivePlayers(active);

    for (const entry of previewEntries) {
      entry.wasNewPlayer = isNewByPlayerId.get(entry.playerId) === true;
    }

    const winChance = await loadRosterWinChance(leagueId, previewEntries, tx);
    await writeMatchRatingSnapshots(
      leagueId,
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
          isGriefer: grieferSet.has(player.slot),
          result: won ? 'WIN' : 'LOSS',
          wasNewPlayer: isNewByPlayerId.get(player.playerId) === true,
        },
      });
    }

    await applyQuitterPenalties(leagueId, entries, tx);
    const preMatchGlobal = await loadPreMatchGlobalByPlayer(matchId, tx);
    const preMatchDisplayStats = await loadMatchDisplayStatsByPlayer(leagueId, playerIds, tx);
    const preMatchGamesByPlayer = gamesByPlayerFromStats(preMatchDisplayStats);
    await accrueGrieferPenalties(matchId, entries, preMatchGlobal, preMatchGamesByPlayer, tx);
    const completedAt = new Date();
    await applyMatchRatings(leagueId, entries, winningTeam, completedAt, tx);

    await tx.match.update({
      where: { id: matchId },
      data: { status: 'COMPLETED', completedAt },
    });

    const displayStats = await loadMatchDisplayStatsByPlayer(leagueId, playerIds, tx);
    const gamesByPlayer = gamesByPlayerFromStats(displayStats);
    const clearIds = playerIdsToClearNewFlag(playerIds, gamesByPlayer);
    if (clearIds.length > 0) {
      await tx.playerRating.updateMany({
        where: { leagueId, playerId: { in: clearIds }, isNewPlayer: true },
        data: { isNewPlayer: false },
      });
    }

    const afterBySlot = await loadPlayerKiBySlot(leagueId, previewEntries, tx);
    ratingPreview = buildCompletedRatingPreview(
      previewEntries,
      beforeBySlot,
      afterBySlot,
      gamesByPlayer,
      displayStats,
      winChance,
    );
    await persistMatchRatingPreviewToPlayers(matchId, ratingPreview, match.players, tx);
  });

  const updated = await getMatchById(matchId);
  log.info(
    {
      matchId,
      winningTeam,
      quitterSlots: resolvedQuitterSlots,
      grieferSlots: resolvedGrieferSlots,
    },
    'Match completed',
  );
  return { match: updated!, ratingPreview };
}

export async function cancelInProgressMatch(
  matchId: string,
  grieferSlots?: number[],
): Promise<MatchWithPlayers> {
  let quitterSlots: number[] = [];
  let resolvedGrieferSlots: number[] = [];

  await prisma.$transaction(async (tx) => {
    const match = await lockInProgressMatch(tx, matchId);
    quitterSlots = resolveQuitterSlots(match.players);
    resolvedGrieferSlots = resolveGrieferSlots(match.players, grieferSlots);
    const grieferSet = new Set(resolvedGrieferSlots);
    assertKnownSlots(match, grieferSet, 'griefer');

    if (grieferSlots !== undefined) {
      for (const player of match.players) {
        const isGriefer = grieferSet.has(player.slot);
        await tx.matchPlayer.update({
          where: { matchId_playerId: { matchId, playerId: player.playerId } },
          data: {
            isGriefer,
            ...(isGriefer ? { isQuitter: false } : {}),
          },
        });
      }
    }

    if (isEventMatch(match)) {
      await tx.match.update({
        where: { id: matchId },
        data: { status: 'CANCELLED' },
      });
      return;
    }

    const leagueId = requireLeagueId(match);
    const entries = toRatingEntries(match, new Set(quitterSlots), grieferSet);
    const playerIds = match.players.map((p) => p.playerId);

    if (quitterSlots.length > 0) {
      await applyQuitterPenalties(leagueId, entries, tx);
    }

    if (resolvedGrieferSlots.length > 0) {
      await ensurePlayerRatings(
        leagueId,
        match.players.map((p) => ({ playerId: p.playerId, heroId: p.heroId })),
        tx,
      );
      const liveGlobal = await loadLiveGlobalByPlayer(leagueId, playerIds, tx);
      const displayStats = await loadMatchDisplayStatsByPlayer(leagueId, playerIds, tx);
      const gamesByPlayer = gamesByPlayerFromStats(displayStats);
      await accrueGrieferPenalties(matchId, entries, liveGlobal, gamesByPlayer, tx);
    } else {
      await accrueGrieferPenalties(matchId, entries, new Map(), new Map(), tx);
    }

    await tx.match.update({
      where: { id: matchId },
      data: { status: 'CANCELLED' },
    });
  });

  const updated = await getMatchById(matchId);
  log.info(
    { matchId, quitterSlots, grieferSlots: resolvedGrieferSlots },
    'In-progress match cancelled',
  );
  return updated!;
}

export type ClearedMatchGriefer = {
  slot: number;
  playerId: string;
  kiTaxRemoved: number;
};

/**
 * Clear griefer flags and deferred ki accrual on a finished match (mods).
 * When `slots` is omitted or empty, clears every griefer on the match.
 */
export async function clearMatchGriefers(
  matchId: string,
  slots?: number[],
): Promise<{ match: MatchWithPlayers; cleared: ClearedMatchGriefer[] }> {
  const match = await getMatchById(matchId);

  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }

  if (match.status !== 'COMPLETED' && match.status !== 'CANCELLED') {
    throw new MatchServiceError(
      'Griefer flags can only be cleared on completed or cancelled matches.',
    );
  }

  const targetSlots =
    slots !== undefined && slots.length > 0
      ? new Set(slots)
      : new Set(match.players.filter((player) => player.isGriefer).map((player) => player.slot));

  if (targetSlots.size === 0) {
    throw new MatchServiceError('This match has no griefers to clear.');
  }

  if (slots !== undefined && slots.length > 0) {
    assertKnownSlots(match, targetSlots, 'griefer');
  }

  const cleared: ClearedMatchGriefer[] = [];

  await prisma.$transaction(async (tx) => {
    for (const player of match.players) {
      if (!targetSlots.has(player.slot)) {
        continue;
      }

      if (!player.isGriefer && player.grieferKiAccrued == null) {
        continue;
      }

      cleared.push({
        slot: player.slot,
        playerId: player.playerId,
        kiTaxRemoved: player.grieferKiAccrued ?? 0,
      });

      await tx.matchPlayer.update({
        where: { matchId_playerId: { matchId, playerId: player.playerId } },
        data: { isGriefer: false, grieferKiAccrued: null },
      });
    }
  });

  if (cleared.length === 0) {
    throw new MatchServiceError('The selected slots are not marked as griefers.');
  }

  const updated = await getMatchById(matchId);
  log.info({ matchId, cleared }, 'Griefers cleared from match');
  return { match: updated!, cleared };
}
