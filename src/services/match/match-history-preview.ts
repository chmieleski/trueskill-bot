import { prisma } from '../../lib/prisma.js';
import { displayOrdinal } from '../rating/rating-math.js';
import {
  buildCompletedRatingPreview,
  matchPlayersToRatingEntries,
  type LobbyRatingPreview,
  type PlayerKiPair,
} from '../rating/rating-preview.js';
import {
  simulatePostMatchRatings,
  type RatingRosterEntry,
} from '../rating/rating-update.js';
import { expectedSnapshotCount } from './match-correction.js';
import type { MatchWithPlayers } from './match-service.js';

type SnapshotRow = {
  playerId: string;
  entityKind: 'GLOBAL' | 'HERO';
  heroId: number;
  mu: number;
  sigma: number;
  matchesPlayed: number | null;
};

function winningTeamFromPlayers(
  players: Array<{ team: number; result: string | null }>,
): 1 | 2 {
  return players.some((player) => player.result === 'WIN' && player.team === 1) ? 1 : 2;
}

/**
 * Count completed WIN/LOSS appearances before this match (for displayOrdinal soft-z).
 */
async function loadGlobalGamesBeforeMatch(
  leagueId: string,
  playerIds: string[],
  completedAt: Date | null,
  matchId: string,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>(playerIds.map((id) => [id, 0]));
  if (playerIds.length === 0 || !completedAt) {
    return counts;
  }

  const rows = await prisma.matchPlayer.groupBy({
    by: ['playerId'],
    where: {
      playerId: { in: playerIds },
      result: { in: ['WIN', 'LOSS'] },
      match: {
        leagueId,
        status: 'COMPLETED',
        id: { not: matchId },
        completedAt: { lt: completedAt },
      },
    },
    _count: { _all: true },
  });

  for (const row of rows) {
    counts.set(row.playerId, row._count._all);
  }
  return counts;
}

function snapshotsToMaps(snapshots: SnapshotRow[]): {
  globalByPlayer: Map<string, { mu: number; sigma: number }>;
  heroByKey: Map<string, { mu: number; sigma: number; matchesPlayed: number }>;
} {
  const globalByPlayer = new Map<string, { mu: number; sigma: number }>();
  const heroByKey = new Map<string, { mu: number; sigma: number; matchesPlayed: number }>();

  for (const snap of snapshots) {
    if (snap.entityKind === 'GLOBAL') {
      globalByPlayer.set(snap.playerId, { mu: snap.mu, sigma: snap.sigma });
      continue;
    }
    heroByKey.set(`${snap.playerId}:${snap.heroId}`, {
      mu: snap.mu,
      sigma: snap.sigma,
      matchesPlayed: snap.matchesPlayed ?? 0,
    });
  }

  return { globalByPlayer, heroByKey };
}

function kiPairFromState(
  playerId: string,
  heroId: number | null,
  globalByPlayer: Map<string, { mu: number; sigma: number }>,
  heroByKey: Map<string, { mu: number; sigma: number; matchesPlayed?: number }>,
  globalGames: number,
  heroGames: number,
): PlayerKiPair {
  const global = globalByPlayer.get(playerId) ?? { mu: 25, sigma: 8.333 };
  const globalKi = displayOrdinal(global.mu, global.sigma, globalGames);
  if (heroId == null) {
    return { global: globalKi, hero: globalKi };
  }
  const hero = heroByKey.get(`${playerId}:${heroId}`) ?? { mu: 25, sigma: 8.333 };
  return {
    global: globalKi,
    hero: displayOrdinal(hero.mu, hero.sigma, heroGames),
  };
}

/**
 * Rebuild completed-match rating preview (with deltas) from pre-match snapshots
 * by replaying OpenSkill in memory. Returns undefined when snapshots are missing.
 */
export async function rebuildCompletedRatingPreview(
  match: MatchWithPlayers,
): Promise<LobbyRatingPreview | undefined> {
  const snapshots = await prisma.matchRatingSnapshot.findMany({
    where: { matchId: match.id },
  });

  if (snapshots.length !== expectedSnapshotCount(match.players)) {
    return undefined;
  }

  const { globalByPlayer, heroByKey } = snapshotsToMaps(snapshots);
  const previewEntries = matchPlayersToRatingEntries(match.players);
  const rosterEntries: RatingRosterEntry[] = match.players.map((player) => ({
    playerId: player.playerId,
    slot: player.slot,
    team: player.team === 1 || player.team === 2 ? player.team : 1,
    heroId: player.heroId,
    isQuitter: player.isQuitter,
  }));

  const winningTeam = winningTeamFromPlayers(match.players);
  const afterMaps = simulatePostMatchRatings(
    rosterEntries,
    winningTeam,
    globalByPlayer,
    new Map(
      [...heroByKey.entries()].map(([key, value]) => [
        key,
        { mu: value.mu, sigma: value.sigma },
      ]),
    ),
  );

  const globalGames = await loadGlobalGamesBeforeMatch(
    match.leagueId,
    match.players.map((player) => player.playerId),
    match.completedAt,
    match.id,
  );

  const beforeBySlot = new Map<number, PlayerKiPair>();
  const afterBySlot = new Map<number, PlayerKiPair>();

  for (const entry of previewEntries) {
    const heroSnap =
      entry.heroId != null
        ? heroByKey.get(`${entry.playerId}:${entry.heroId}`)
        : undefined;
    const heroGamesBefore = heroSnap?.matchesPlayed ?? 0;
    const heroGamesAfter =
      entry.heroId != null && !entry.isQuitter ? heroGamesBefore + 1 : heroGamesBefore;
    const games = globalGames.get(entry.playerId) ?? 0;

    beforeBySlot.set(
      entry.slot,
      kiPairFromState(
        entry.playerId,
        entry.heroId,
        globalByPlayer,
        heroByKey,
        games,
        heroGamesBefore,
      ),
    );
    afterBySlot.set(
      entry.slot,
      kiPairFromState(
        entry.playerId,
        entry.heroId,
        afterMaps.globalByPlayer,
        afterMaps.heroByKey,
        games,
        heroGamesAfter,
      ),
    );
  }

  return buildCompletedRatingPreview(previewEntries, beforeBySlot, afterBySlot);
}

/** Target player's global ki delta for a completed match, if snapshots allow. */
export async function loadPlayerGlobalDeltaForMatch(
  match: MatchWithPlayers,
  playerId: string,
): Promise<number | undefined> {
  const preview = await rebuildCompletedRatingPreview(match);
  if (!preview) {
    return undefined;
  }
  const slot = match.players.find((player) => player.playerId === playerId)?.slot;
  if (slot == null) {
    return undefined;
  }
  return preview.players.find((line) => line.slot === slot)?.globalDelta;
}
