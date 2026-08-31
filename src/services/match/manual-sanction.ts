import { prisma } from '../../lib/prisma.js';
import { createLogger } from '../../lib/logger.js';
import { getGameProfileForLeague } from '../league/league-profile.js';
import { isLeagueWritable, LEAGUE_ARCHIVED_MESSAGE } from '../league/league.js';
import { ensurePlayerRatings } from '../rating/rating-preview.js';
import {
  accrueGrieferPenalties,
  applyQuitterPenalties,
  loadLiveGlobalByPlayer,
  type RatingRosterEntry,
} from '../rating/rating-update.js';
import {
  gamesByPlayerFromStats,
  loadMatchDisplayStatsByPlayer,
} from '../rating/rank-reset-display.js';
import { restoreMatchRatingSnapshots, writeMatchRatingSnapshots } from './match-correction.js';
import {
  clearMatchGriefers,
  clearMatchQuitters,
  type ClearMatchQuittersResult,
} from './match-report.js';
import { getMatchById, MatchServiceError } from './match-service.js';

const log = createLogger('manual_sanction');

export type ManualSanctionType = 'quitter' | 'griefer';

export type AddManualSanctionInput = {
  leagueId: string;
  playerId: string;
  type: ManualSanctionType;
  actorDiscordId: string;
  discordChannelId: string;
};

export type AddManualSanctionResult = {
  matchId: string;
  username: string;
  type: ManualSanctionType;
  quits: number;
  griefs: number;
  grieferKiAccrued: number | null;
};

export type RemoveManualSanctionInput = {
  leagueId: string;
  playerId: string;
  username: string;
  type: ManualSanctionType;
  matchId?: string;
};

export type RemoveManualSanctionResult = {
  matchId: string;
  type: ManualSanctionType;
  username: string;
  mode: 'manual_restored' | 'delegated_clear';
  clearResult?: ClearMatchQuittersResult;
};

/** Latest manual sanction match for a player and flag type in a league. */
export async function findLatestManualSanctionMatchId(
  leagueId: string,
  playerId: string,
  type: ManualSanctionType,
): Promise<string | null> {
  const row = await prisma.matchPlayer.findFirst({
    where: {
      playerId,
      isQuitter: type === 'quitter',
      ...(type === 'griefer' ? { isGriefer: true, isQuitter: false } : {}),
      match: {
        leagueId,
        isManualSanction: true,
        status: 'CANCELLED',
      },
    },
    orderBy: { match: { createdAt: 'desc' } },
    select: { matchId: true },
  });
  return row?.matchId ?? null;
}

async function assertLeagueWritableForSanction(leagueId: string): Promise<void> {
  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    select: { status: true },
  });
  if (!league || !isLeagueWritable(league)) {
    throw new MatchServiceError(LEAGUE_ARCHIVED_MESSAGE);
  }
}

function manualSanctionNotFoundMessage(type: ManualSanctionType, username: string): string {
  const label = type === 'quitter' ? 'quitter' : 'griefer';
  return `No manual ${label} sanction found for **${username}**.`;
}

function buildSanctionEntry(
  playerId: string,
  heroId: number | null,
  type: ManualSanctionType,
): RatingRosterEntry {
  return {
    playerId,
    slot: 1,
    team: 1,
    heroId,
    isQuitter: type === 'quitter',
    isGriefer: type === 'griefer',
  };
}

/**
 * Record one mod-added quitter or griefer incident without a real lobby.
 * Applies the same penalties as cancel/complete (synthetics or deferred ki tax).
 */
export async function addManualSanction(
  input: AddManualSanctionInput,
): Promise<AddManualSanctionResult> {
  await assertLeagueWritableForSanction(input.leagueId);

  const [profile, player] = await Promise.all([
    getGameProfileForLeague(input.leagueId),
    prisma.player.findUnique({
      where: { id: input.playerId },
      select: { id: true, username: true },
    }),
  ]);

  if (!player) {
    throw new MatchServiceError('Player not found.');
  }

  const heroId = profile.heroBinding === 'slot_bound' ? 1 : null;
  let matchId = '';

  await prisma.$transaction(async (tx) => {
    const match = await tx.match.create({
      data: {
        status: 'CANCELLED',
        isManualSanction: true,
        leagueId: input.leagueId,
        hostDiscordId: input.actorDiscordId,
        discordChannelId: input.discordChannelId,
      },
    });
    matchId = match.id;

    await tx.matchPlayer.create({
      data: {
        matchId,
        playerId: input.playerId,
        team: 1,
        slot: 1,
        heroId,
        isQuitter: input.type === 'quitter',
        isGriefer: input.type === 'griefer',
      },
    });

    const snapshotPlayers = [{ playerId: input.playerId, heroId }];
    await ensurePlayerRatings(input.leagueId, snapshotPlayers, tx);

    const entry = buildSanctionEntry(input.playerId, heroId, input.type);

    if (input.type === 'quitter') {
      await writeMatchRatingSnapshots(input.leagueId, matchId, snapshotPlayers, tx);
      await applyQuitterPenalties(input.leagueId, [entry], tx);
    } else {
      const liveGlobal = await loadLiveGlobalByPlayer(input.leagueId, [input.playerId], tx);
      const displayStats = await loadMatchDisplayStatsByPlayer(
        input.leagueId,
        [input.playerId],
        tx,
      );
      const gamesByPlayer = gamesByPlayerFromStats(displayStats);
      await accrueGrieferPenalties(matchId, [entry], liveGlobal, gamesByPlayer, tx);
    }
  });

  const [displayStats, matchPlayer] = await Promise.all([
    loadMatchDisplayStatsByPlayer(input.leagueId, [input.playerId]),
    prisma.matchPlayer.findUnique({
      where: { matchId_playerId: { matchId, playerId: input.playerId } },
      select: { grieferKiAccrued: true },
    }),
  ]);

  const stats = displayStats.get(input.playerId);

  log.info(
    { matchId, playerId: input.playerId, type: input.type, leagueId: input.leagueId },
    'Manual sanction added',
  );

  return {
    matchId,
    username: player.username,
    type: input.type,
    quits: stats?.quits ?? 0,
    griefs: stats?.griefs ?? 0,
    grieferKiAccrued: matchPlayer?.grieferKiAccrued ?? null,
  };
}

async function clearManualQuitterWithRestore(leagueId: string, matchId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await restoreMatchRatingSnapshots(leagueId, matchId, tx);
    const players = await tx.matchPlayer.findMany({
      where: { matchId, isQuitter: true },
      select: { playerId: true },
    });
    for (const player of players) {
      await tx.matchPlayer.update({
        where: { matchId_playerId: { matchId, playerId: player.playerId } },
        data: { isQuitter: false },
      });
    }
  });
}

function assertPlayerHasSanctionFlag(
  match: NonNullable<Awaited<ReturnType<typeof getMatchById>>>,
  playerId: string,
  type: ManualSanctionType,
): number {
  const player = match.players.find((row) => row.playerId === playerId);
  if (!player) {
    throw new MatchServiceError('That player is not on this match.');
  }

  if (type === 'quitter' && !player.isQuitter) {
    throw new MatchServiceError('The selected slots are not marked as quitters.');
  }

  if (type === 'griefer' && (!player.isGriefer || player.isQuitter)) {
    throw new MatchServiceError('The selected slots are not marked as griefers.');
  }

  return player.slot;
}

/**
 * Remove one quitter or griefer marker. Without match_id, clears the latest manual sanction.
 * With match_id, delegates to existing clear helpers on that finished match.
 */
export async function removeManualSanction(
  input: RemoveManualSanctionInput,
): Promise<RemoveManualSanctionResult> {
  await assertLeagueWritableForSanction(input.leagueId);

  const resolvedMatchId =
    input.matchId ??
    (await findLatestManualSanctionMatchId(input.leagueId, input.playerId, input.type));

  if (!resolvedMatchId) {
    throw new MatchServiceError(manualSanctionNotFoundMessage(input.type, input.username));
  }

  if (input.matchId) {
    const match = await getMatchById(resolvedMatchId);
    if (!match) {
      throw new MatchServiceError('This match was not found.');
    }
    if (match.leagueId !== input.leagueId) {
      throw new MatchServiceError('This match is not in the selected league.');
    }

    const slot = assertPlayerHasSanctionFlag(match, input.playerId, input.type);

    if (input.type === 'quitter') {
      const clearResult = await clearMatchQuitters(resolvedMatchId, [slot]);
      log.info(
        { matchId: resolvedMatchId, playerId: input.playerId },
        'Manual sanction remove (delegated unquit)',
      );
      return {
        matchId: resolvedMatchId,
        type: input.type,
        username: input.username,
        mode: 'delegated_clear',
        clearResult,
      };
    }

    await clearMatchGriefers(resolvedMatchId, [slot]);
    log.info(
      { matchId: resolvedMatchId, playerId: input.playerId },
      'Manual sanction remove (delegated ungrief)',
    );
    return {
      matchId: resolvedMatchId,
      type: input.type,
      username: input.username,
      mode: 'delegated_clear',
    };
  }

  const match = await getMatchById(resolvedMatchId);
  if (!match?.isManualSanction) {
    throw new MatchServiceError(manualSanctionNotFoundMessage(input.type, input.username));
  }

  assertPlayerHasSanctionFlag(match, input.playerId, input.type);

  if (input.type === 'griefer') {
    await clearMatchGriefers(resolvedMatchId);
  } else {
    await clearManualQuitterWithRestore(input.leagueId, resolvedMatchId);
  }

  log.info(
    { matchId: resolvedMatchId, playerId: input.playerId, type: input.type },
    'Manual sanction removed',
  );

  return {
    matchId: resolvedMatchId,
    type: input.type,
    username: input.username,
    mode: input.type === 'quitter' ? 'manual_restored' : 'delegated_clear',
  };
}
