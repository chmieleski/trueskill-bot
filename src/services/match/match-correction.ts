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
import { assertTeam } from '../../domain/game-profile.js';
import {
  applyMatchRatings,
  applyQuitterPenalties,
  assertBothTeamsHaveActivePlayers,
  type RatingRosterEntry,
} from '../rating/rating-update.js';
import { resolveQuitterSlots } from './match-report.js';
import type { CompleteMatchResult } from './match-report.js';

const log = createLogger('match-correction');

export const CORRECTION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const GLOBAL_SNAPSHOT_HERO_ID = 0;

type Db = Prisma.TransactionClient | typeof prisma;

type SnapshotPlayer = {
  playerId: string;
  heroId: number | null;
};

// ─────────────────────────────────────────────────────────────
// CustomId helpers (≤100 chars, prefix `matchcorr`)
// ─────────────────────────────────────────────────────────────

/** Encode slot array as dash-joined string; empty = single dash. */
function encodeSlots(slots: number[]): string {
  const normalized = [...new Set(slots)].sort((a, b) => a - b);
  return normalized.length > 0 ? normalized.join('-') : '-';
}

/** Decode slot string back to number array. */
function decodeSlots(raw: string | undefined): number[] {
  if (!raw || raw === '-') {
    return [];
  }
  return raw
    .split('-')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

export type MatchCorrectionConfirmInput =
  | {
      action: 'flip';
      matchId: string;
      actorDiscordId: string;
      winningTeam: 1 | 2;
      quitterSlots: number[];
    }
  | {
      action: 'void';
      matchId: string;
      actorDiscordId: string;
    };

export type MatchCorrectionButtonParsed =
  | {
      kind: 'confirm' | 'cancel';
      action: 'flip';
      matchId: string;
      actorDiscordId: string;
      winningTeam: 1 | 2;
      quitterSlots: number[];
    }
  | {
      kind: 'confirm' | 'cancel';
      action: 'void';
      matchId: string;
      actorDiscordId: string;
    };

/**
 * Build a confirm button customId for a flip or void correction.
 * Format:
 *   flip → `matchcorr:ok:f:{matchId}:{actorDiscordId}:{winningTeam}:{slots}`
 *   void → `matchcorr:ok:v:{matchId}:{actorDiscordId}`
 */
export function buildMatchCorrectionConfirmCustomId(input: MatchCorrectionConfirmInput): string {
  if (input.action === 'flip') {
    return `matchcorr:ok:f:${input.matchId}:${input.actorDiscordId}:${input.winningTeam}:${encodeSlots(input.quitterSlots)}`;
  }
  return `matchcorr:ok:v:${input.matchId}:${input.actorDiscordId}`;
}

/**
 * Build a cancel button customId for a flip or void correction.
 * Format mirrors confirm but uses `no` instead of `ok`.
 */
export function buildMatchCorrectionCancelCustomId(input: MatchCorrectionConfirmInput): string {
  if (input.action === 'flip') {
    return `matchcorr:no:f:${input.matchId}:${input.actorDiscordId}:${input.winningTeam}:${encodeSlots(input.quitterSlots)}`;
  }
  return `matchcorr:no:v:${input.matchId}:${input.actorDiscordId}`;
}

/**
 * Parse a `matchcorr:` button customId.
 * Returns null if the customId is not a matchcorr button.
 */
export function parseMatchCorrectionButtonCustomId(
  customId: string,
): MatchCorrectionButtonParsed | null {
  if (!customId.startsWith('matchcorr:')) {
    return null;
  }

  const parts = customId.split(':');
  // parts[0] = 'matchcorr'
  const confirm = parts[1]; // 'ok' or 'no'
  const actionCode = parts[2]; // 'f' or 'v'
  const kind: 'confirm' | 'cancel' = confirm === 'ok' ? 'confirm' : 'cancel';

  if (actionCode === 'f') {
    // matchcorr:{ok|no}:f:{matchId}:{actorDiscordId}:{team}:{slots}
    const matchId = parts[3];
    const actorDiscordId = parts[4];
    const teamRaw = Number(parts[5]);
    if (teamRaw !== 1 && teamRaw !== 2) {
      return null;
    }
    const winningTeam: 1 | 2 = teamRaw;
    const quitterSlots = decodeSlots(parts[6]);
    if (!matchId || !actorDiscordId) {
      return null;
    }
    return { kind, action: 'flip', matchId, actorDiscordId, winningTeam, quitterSlots };
  }

  if (actionCode === 'v') {
    // matchcorr:{ok|no}:v:{matchId}:{actorDiscordId}
    const matchId = parts[3];
    const actorDiscordId = parts[4];
    if (!matchId || !actorDiscordId) {
      return null;
    }
    return { kind, action: 'void', matchId, actorDiscordId };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// Eligibility
// ─────────────────────────────────────────────────────────────

/**
 * Returns true if completedAt is non-null and within the correction window.
 */
export function isWithinCorrectionWindow(
  completedAt: Date | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!completedAt) {
    return false;
  }
  return nowMs - completedAt.getTime() <= CORRECTION_WINDOW_MS;
}

/**
 * Throws MatchServiceError if the match is not correctable.
 */
export function assertMatchCorrectable(match: {
  status: string;
  completedAt: Date | null;
}): void {
  if (match.status !== 'COMPLETED') {
    throw new MatchServiceError('This match is not completed.');
  }
  if (!isWithinCorrectionWindow(match.completedAt)) {
    throw new MatchServiceError(
      'This match can only be corrected within 24 hours of completion.',
    );
  }
}

/**
 * Expected snapshot rows: GLOBAL for every player, plus HERO when heroId is set.
 */
export function expectedSnapshotCount(players: { heroId: number | null }[]): number {
  return players.reduce((count, player) => count + (player.heroId == null ? 1 : 2), 0);
}

/**
 * Throws MatchServiceError if snapshots are missing for the roster.
 */
export async function assertSnapshotsComplete(
  matchId: string,
  players: { heroId: number | null }[],
  db: Db = prisma,
): Promise<void> {
  const count = await db.matchRatingSnapshot.count({ where: { matchId } });
  if (count !== expectedSnapshotCount(players)) {
    throw new MatchServiceError(
      'This match cannot be corrected because rating snapshots are missing.',
    );
  }
}

/**
 * Returns true if any of the given players completed another match
 * in this league after completedAt.
 */
export async function hasNewerCompletedMatches(
  leagueId: string,
  matchId: string,
  completedAt: Date,
  playerIds: string[],
  db: Db = prisma,
): Promise<boolean> {
  if (playerIds.length === 0) {
    return false;
  }
  const newer = await db.matchPlayer.findFirst({
    where: {
      playerId: { in: playerIds },
      matchId: { not: matchId },
      match: {
        leagueId,
        status: 'COMPLETED',
        completedAt: { gt: completedAt },
      },
    },
    select: { playerId: true },
  });
  return newer !== null;
}

// ─────────────────────────────────────────────────────────────
// Snapshot write (called from completeMatch in match-report)
// ─────────────────────────────────────────────────────────────

/**
 * Persist pre-apply μ/σ (and hero matchesPlayed) for every roster player.
 * Call once before OpenSkill writes on first complete.
 * Throws MatchServiceError if snapshots already exist for this match.
 * When `heroId` is null, writes GLOBAL only (no hero row required).
 */
export async function writeMatchRatingSnapshots(
  leagueId: string,
  matchId: string,
  players: SnapshotPlayer[],
  db: Db = prisma,
): Promise<void> {
  const existing = await db.matchRatingSnapshot.count({ where: { matchId } });
  if (existing > 0) {
    throw new MatchServiceError('Rating snapshots already exist for this match.');
  }

  const playerIds = players.map((p) => p.playerId);
  const withHero = players.filter(
    (p): p is SnapshotPlayer & { heroId: number } => p.heroId != null,
  );
  const [globals, heroes] = await Promise.all([
    db.playerRating.findMany({ where: { leagueId, playerId: { in: playerIds } } }),
    withHero.length > 0
      ? db.playerHeroRating.findMany({
          where: {
            leagueId,
            OR: withHero.map((p) => ({ playerId: p.playerId, heroId: p.heroId })),
          },
        })
      : Promise.resolve([]),
  ]);

  const globalByPlayer = new Map(globals.map((row) => [row.playerId, row]));
  const heroByKey = new Map(heroes.map((row) => [`${row.playerId}:${row.heroId}`, row]));

  const rows = players.flatMap((player) => {
    const global = globalByPlayer.get(player.playerId);
    if (!global) {
      throw new MatchServiceError(
        'Cannot snapshot ratings: missing player or hero rating rows.',
      );
    }

    const globalRow = {
      matchId,
      playerId: player.playerId,
      entityKind: 'GLOBAL' as const,
      heroId: GLOBAL_SNAPSHOT_HERO_ID,
      mu: global.mu,
      sigma: global.sigma,
      matchesPlayed: null,
    };

    if (player.heroId == null) {
      return [globalRow];
    }

    const hero = heroByKey.get(`${player.playerId}:${player.heroId}`);
    if (!hero) {
      throw new MatchServiceError(
        'Cannot snapshot ratings: missing player or hero rating rows.',
      );
    }

    return [
      globalRow,
      {
        matchId,
        playerId: player.playerId,
        entityKind: 'HERO' as const,
        heroId: player.heroId,
        mu: hero.mu,
        sigma: hero.sigma,
        matchesPlayed: hero.matchesPlayed,
      },
    ];
  });

  await db.matchRatingSnapshot.createMany({ data: rows });
}

// ─────────────────────────────────────────────────────────────
// Snapshot restore
// ─────────────────────────────────────────────────────────────

/**
 * Restore all player ratings to their pre-match snapshots.
 * Must be called inside the correction transaction before re-applying.
 */
export async function restoreMatchRatingSnapshots(
  leagueId: string,
  matchId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const snapshots = await tx.matchRatingSnapshot.findMany({ where: { matchId } });

  for (const snap of snapshots) {
    if (snap.entityKind === 'GLOBAL') {
      await tx.playerRating.update({
        where: { leagueId_playerId: { leagueId, playerId: snap.playerId } },
        data: { mu: snap.mu, sigma: snap.sigma },
      });
    } else {
      await tx.playerHeroRating.update({
        where: {
          leagueId_playerId_heroId: {
            leagueId,
            playerId: snap.playerId,
            heroId: snap.heroId,
          },
        },
        data: {
          mu: snap.mu,
          sigma: snap.sigma,
          matchesPlayed: snap.matchesPlayed ?? 0,
        },
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Preview
// ─────────────────────────────────────────────────────────────

export type MatchCorrectionPreview = {
  match: MatchWithPlayers;
  canCorrect: boolean;
  hasNewerMatches: boolean;
  /** Present when canCorrect is false. */
  correctionBlockReason?: string;
};

/**
 * Load the match and determine whether a correction is currently possible.
 * Does not mutate anything.
 */
export async function previewMatchCorrection(matchId: string): Promise<MatchCorrectionPreview> {
  const match = await getMatchById(matchId);
  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }

  if (match.status !== 'COMPLETED') {
    return {
      match,
      canCorrect: false,
      hasNewerMatches: false,
      correctionBlockReason: 'This match is not completed.',
    };
  }

  if (!isWithinCorrectionWindow(match.completedAt)) {
    return {
      match,
      canCorrect: false,
      hasNewerMatches: false,
      correctionBlockReason: 'This match can only be corrected within 24 hours of completion.',
    };
  }

  const snapshotCount = await prisma.matchRatingSnapshot.count({ where: { matchId } });
  if (snapshotCount !== expectedSnapshotCount(match.players)) {
    return {
      match,
      canCorrect: false,
      hasNewerMatches: false,
      correctionBlockReason: 'This match cannot be corrected because rating snapshots are missing.',
    };
  }

  const playerIds = match.players.map((p) => p.playerId);
  const newerMatches = await hasNewerCompletedMatches(
    match.leagueId,
    matchId,
    match.completedAt!,
    playerIds,
  );

  return { match, canCorrect: true, hasNewerMatches: newerMatches };
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

function isWinningTeam(team: number, winningTeam: 1 | 2): boolean {
  return team === winningTeam;
}

function toRatingEntries(
  match: MatchWithPlayers,
  quitterSet: Set<number>,
): RatingRosterEntry[] {
  return match.players.map((player) => ({
    playerId: player.playerId,
    slot: player.slot,
    team: assertTeam(player.team),
    heroId: player.heroId,
    isQuitter: quitterSet.has(player.slot),
  }));
}

function assertKnownQuitterSlots(match: MatchWithPlayers, quitterSet: Set<number>): void {
  for (const slot of quitterSet) {
    if (!match.players.some((p) => p.slot === slot)) {
      throw new MatchServiceError(`No player in slot ${slot}.`);
    }
  }
}

async function lockCompletedMatch(
  tx: Prisma.TransactionClient,
  matchId: string,
): Promise<MatchWithPlayers> {
  await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Match"
    WHERE id = ${matchId} AND status = 'COMPLETED'
    FOR UPDATE
  `;

  const match = await tx.match.findUnique({
    where: { id: matchId },
    include: {
      players: {
        include: { player: true },
        orderBy: { slot: 'asc' },
      },
    },
  });

  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }
  if (match.status !== 'COMPLETED') {
    throw new MatchServiceError('This match is not completed.');
  }
  return match as MatchWithPlayers;
}

// ─────────────────────────────────────────────────────────────
// Flip
// ─────────────────────────────────────────────────────────────

/**
 * Correct a completed match's result by flipping the winner.
 * Restores pre-match ratings, then re-applies with the corrected outcome.
 * Does NOT touch snapshots or completedAt.
 */
export async function flipCompletedMatch(
  matchId: string,
  winningTeam: 1 | 2,
  quitterSlots?: number[],
): Promise<CompleteMatchResult> {
  let resolvedQuitterSlots: number[] = [];
  let ratingPreview: LobbyRatingPreview = { players: [] };

  await prisma.$transaction(async (tx) => {
    const match = await lockCompletedMatch(tx, matchId);
    assertMatchCorrectable(match);
    await assertSnapshotsComplete(matchId, match.players, tx);

    await restoreMatchRatingSnapshots(match.leagueId, matchId, tx);

    resolvedQuitterSlots = resolveQuitterSlots(match.players, quitterSlots);
    const quitterSet = new Set(resolvedQuitterSlots);
    assertKnownQuitterSlots(match, quitterSet);

    const entries = toRatingEntries(match, quitterSet);
    const active = entries.filter((e) => !e.isQuitter);
    assertBothTeamsHaveActivePlayers(active);

    const previewEntries = matchPlayersToRatingEntries(
      match.players.map((p) => ({
        ...p,
        isQuitter: quitterSet.has(p.slot),
      })),
    );
    await ensurePlayerRatings(
      match.leagueId,
      match.players.map((p) => ({ playerId: p.playerId, heroId: p.heroId })),
      tx,
    );
    const beforeBySlot = await loadPlayerKiBySlot(match.leagueId, previewEntries, tx);

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

    const afterBySlot = await loadPlayerKiBySlot(match.leagueId, previewEntries, tx);
    ratingPreview = buildCompletedRatingPreview(previewEntries, beforeBySlot, afterBySlot);
  });

  const updated = await getMatchById(matchId);
  log.info({ matchId, winningTeam, quitterSlots: resolvedQuitterSlots }, 'Match flip corrected');
  return { match: updated!, ratingPreview };
}

// ─────────────────────────────────────────────────────────────
// Void
// ─────────────────────────────────────────────────────────────

/**
 * Void a completed match: restore ratings, clear player results, set CANCELLED.
 * Leaves completedAt as-is for audit purposes.
 */
export async function voidCompletedMatch(matchId: string): Promise<MatchWithPlayers> {
  await prisma.$transaction(async (tx) => {
    const match = await lockCompletedMatch(tx, matchId);
    assertMatchCorrectable(match);
    await assertSnapshotsComplete(matchId, match.players, tx);

    await restoreMatchRatingSnapshots(match.leagueId, matchId, tx);

    for (const player of match.players) {
      await tx.matchPlayer.update({
        where: { matchId_playerId: { matchId, playerId: player.playerId } },
        data: { result: null, isQuitter: false },
      });
    }

    await tx.match.update({
      where: { id: matchId },
      data: { status: 'CANCELLED' },
    });
  });

  const updated = await getMatchById(matchId);
  log.info({ matchId }, 'Match voided');
  return updated!;
}
