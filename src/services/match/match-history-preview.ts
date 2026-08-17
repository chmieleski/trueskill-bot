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
 * by replaying OpenSkill in memory. Returns undefined when GLOBAL snapshots are missing.
 */
export async function rebuildCompletedRatingPreview(
  match: MatchWithPlayers,
): Promise<LobbyRatingPreview | undefined> {
  const snapshots = await prisma.matchRatingSnapshot.findMany({
    where: { matchId: match.id },
  });

  const playerIds = match.players.map((player) => player.playerId);
  const globalSnaps = snapshots.filter((snap) => snap.entityKind === 'GLOBAL');
  if (!playerIds.every((playerId) => globalSnaps.some((snap) => snap.playerId === playerId))) {
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

  let afterMaps: ReturnType<typeof simulatePostMatchRatings>;
  try {
    const winningTeam = winningTeamFromPlayers(match.players);
    afterMaps = simulatePostMatchRatings(
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
  } catch {
    return undefined;
  }

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

/** Persist completed-match display ki onto MatchPlayer rows for history/show. */
export async function persistMatchRatingPreviewToPlayers(
  matchId: string,
  preview: LobbyRatingPreview,
  matchPlayers: Array<{ playerId: string; slot: number; heroId: number | null }>,
  db: { matchPlayer: { update: typeof prisma.matchPlayer.update } } = prisma,
): Promise<void> {
  const bySlot = new Map(preview.players.map((line) => [line.slot, line]));

  for (const player of matchPlayers) {
    const line = bySlot.get(player.slot);
    if (!line) {
      continue;
    }

    const showHero = line.showHero !== false && player.heroId != null;
    await db.matchPlayer.update({
      where: { matchId_playerId: { matchId, playerId: player.playerId } },
      data: {
        globalKi: line.globalOrdinal,
        globalKiDelta: line.globalDelta ?? null,
        heroKi: showHero ? line.heroOrdinal : null,
        heroKiDelta: showHero ? (line.heroDelta ?? null) : null,
      },
    });
  }
}

/** Build rating preview from MatchPlayer ki columns written at complete time. */
export function ratingPreviewFromStoredMatchPlayers(
  match: MatchWithPlayers,
): LobbyRatingPreview | undefined {
  if (match.players.some((player) => player.globalKi == null)) {
    return undefined;
  }

  return {
    players: match.players.map((player) => ({
      slot: player.slot,
      nick: player.player.username,
      globalOrdinal: player.globalKi!,
      heroOrdinal: player.heroKi ?? player.globalKi!,
      globalDelta: player.globalKiDelta ?? undefined,
      heroDelta: player.heroKiDelta ?? undefined,
      isQuitter: player.isQuitter,
      showHero: player.heroId != null && player.heroKi != null,
    })),
  };
}

/**
 * Prefer stored MatchPlayer ki, else rebuild from snapshots (and backfill store).
 */
export async function resolveCompletedRatingPreview(
  match: MatchWithPlayers,
): Promise<LobbyRatingPreview | undefined> {
  const stored = ratingPreviewFromStoredMatchPlayers(match);
  if (stored) {
    return stored;
  }

  const rebuilt = await rebuildCompletedRatingPreview(match);
  if (!rebuilt) {
    return undefined;
  }

  try {
    await persistMatchRatingPreviewToPlayers(match.id, rebuilt, match.players);
  } catch {
    // Display still works even if backfill write fails.
  }

  return rebuilt;
}

/** Target player's global ki delta for a completed match, if available. */
export async function loadPlayerGlobalDeltaForMatch(
  match: MatchWithPlayers,
  playerId: string,
): Promise<number | undefined> {
  const stored = match.players.find((player) => player.playerId === playerId)?.globalKiDelta;
  if (stored != null) {
    return stored;
  }

  const preview = await resolveCompletedRatingPreview(match);
  if (!preview) {
    return undefined;
  }
  const slot = match.players.find((player) => player.playerId === playerId)?.slot;
  if (slot == null) {
    return undefined;
  }
  return preview.players.find((line) => line.slot === slot)?.globalDelta;
}
