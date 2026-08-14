import type { Match, MatchPlayer, Player, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { createLogger } from '../lib/logger.js';
import { LobbyOcrError, validateLobbyPlayers, type LobbyPlayer } from './lobby-ocr.js';
import { normalizeNick } from './player-nick.js';
import { ensureHeroesExist } from './rating-preview.js';

const log = createLogger('match');

const TEAM_A_MAX_SLOT = 6;
const STALE_PENDING_MS = 2 * 60 * 60 * 1000;

/** User-facing English errors safe to show in Discord replies. */
export class MatchServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatchServiceError';
  }
}

export type MatchWithPlayers = Match & {
  players: (MatchPlayer & { player: Player })[];
};

export interface CreatedPendingMatch {
  matchId: string;
  createdAt: Date;
  teamACount: number;
  teamBCount: number;
  playerCount: number;
}

export interface CreatePendingMatchInput {
  hostDiscordId: string;
  discordChannelId: string;
  players: LobbyPlayer[];
}

function withNormalizedNicks(players: LobbyPlayer[]): LobbyPlayer[] {
  return players.map((player) => ({ ...player, nick: normalizeNick(player.nick) }));
}

function assertUniqueNicks(players: LobbyPlayer[]): void {
  const seen = new Set<string>();

  for (const player of players) {
    if (player.nick === '') {
      throw new MatchServiceError('Nick cannot be empty.');
    }

    if (seen.has(player.nick)) {
      throw new MatchServiceError(`Duplicate nick "${player.nick}" found in the lobby.`);
    }

    seen.add(player.nick);
  }
}

function assertValidSlots(players: LobbyPlayer[]): void {
  const seenSlots = new Set<number>();

  for (const player of players) {
    if (player.slot < 1 || player.slot > 12) {
      throw new MatchServiceError(`Invalid slot ${player.slot}. Slots must be between 1 and 12.`);
    }

    if (seenSlots.has(player.slot)) {
      throw new MatchServiceError(`Duplicate slot ${player.slot} found in the lobby.`);
    }

    seenSlots.add(player.slot);
  }
}

function toLobbyPlayers(match: MatchWithPlayers): LobbyPlayer[] {
  return match.players
    .map((entry) => ({
      slot: entry.slot,
      nick: normalizeNick(entry.player.username),
    }))
    .sort((a, b) => a.slot - b.slot);
}

function teamCounts(players: LobbyPlayer[]): { teamACount: number; teamBCount: number } {
  const teamACount = players.filter((player) => player.slot <= TEAM_A_MAX_SLOT).length;
  return { teamACount, teamBCount: players.length - teamACount };
}

/**
 * Resolve lobby nicks to Player rows (+ default ratings) with batched queries.
 * Avoids per-player sequential upserts that time out on full 6v6 rosters.
 */
async function resolvePlayersInTx(
  tx: Prisma.TransactionClient,
  players: LobbyPlayer[],
): Promise<{ playerId: string; slot: number; team: number }[]> {
  const sorted = withNormalizedNicks(players).sort((a, b) => a.slot - b.slot);

  if (sorted.length === 0) {
    return [];
  }

  const nicks = sorted.map((player) => player.nick);
  const existing = await tx.player.findMany({
    where: {
      OR: nicks.map((nick) => ({ username: { equals: nick, mode: 'insensitive' as const } })),
    },
  });
  const byNick = new Map(existing.map((row) => [normalizeNick(row.username), row]));

  const missingNicks = nicks.filter((nick) => !byNick.has(nick));
  if (missingNicks.length > 0) {
    await tx.player.createMany({
      data: missingNicks.map((username) => ({ username })),
      skipDuplicates: true,
    });
    const created = await tx.player.findMany({
      where: { username: { in: missingNicks } },
    });
    for (const row of created) {
      byNick.set(normalizeNick(row.username), row);
    }
  }

  const resolved = sorted.map((player) => {
    const dbPlayer = byNick.get(player.nick);
    if (!dbPlayer) {
      throw new MatchServiceError(`Could not resolve player "${player.nick}".`);
    }
    return {
      playerId: dbPlayer.id,
      slot: player.slot,
      team: player.slot <= TEAM_A_MAX_SLOT ? 1 : 2,
    };
  });

  await tx.playerRating.createMany({
    data: resolved.map((entry) => ({ playerId: entry.playerId })),
    skipDuplicates: true,
  });

  await tx.playerHeroRating.createMany({
    data: resolved.map((entry) => ({
      playerId: entry.playerId,
      heroId: entry.slot,
    })),
    skipDuplicates: true,
  });

  return resolved;
}

/**
 * Create a PENDING match immediately on lobby register.
 * Empty roster is allowed (OCR soft-fail / manual fill).
 */
export async function createPendingMatch(
  input: CreatePendingMatchInput,
): Promise<CreatedPendingMatch> {
  const players = withNormalizedNicks(input.players);
  assertValidSlots(players);
  assertUniqueNicks(players);

  await ensureHeroesExist();

  const created = await prisma.$transaction(async (tx) => {
    const resolved = await resolvePlayersInTx(tx, players);

    return tx.match.create({
      data: {
        status: 'PENDING',
        hostDiscordId: input.hostDiscordId,
        discordChannelId: input.discordChannelId,
        players: {
          create: resolved.map((entry) => ({
            playerId: entry.playerId,
            team: entry.team,
            slot: entry.slot,
            heroId: entry.slot,
            result: null,
            isQuitter: false,
          })),
        },
      },
    });
  });

  const { teamACount, teamBCount } = teamCounts(players);

  log.info(
    {
      matchId: created.id,
      hostDiscordId: input.hostDiscordId,
      playerCount: players.length,
      teamACount,
      teamBCount,
    },
    'Pending match created',
  );

  return {
    matchId: created.id,
    createdAt: created.createdAt,
    teamACount,
    teamBCount,
    playerCount: players.length,
  };
}

export async function attachDiscordMessage(
  matchId: string,
  discordMessageId: string,
  discordChannelId: string,
): Promise<void> {
  await prisma.match.update({
    where: { id: matchId },
    data: { discordMessageId, discordChannelId },
  });

  log.debug({ matchId, discordMessageId, discordChannelId }, 'Match Discord message attached');
}

export async function getMatchByDiscordMessageId(
  messageId: string,
): Promise<MatchWithPlayers | null> {
  return prisma.match.findUnique({
    where: { discordMessageId: messageId },
    include: {
      players: {
        include: { player: true },
        orderBy: { slot: 'asc' },
      },
    },
  });
}

export async function getMatchById(matchId: string): Promise<MatchWithPlayers | null> {
  return prisma.match.findUnique({
    where: { id: matchId },
    include: {
      players: {
        include: { player: true },
        orderBy: { slot: 'asc' },
      },
    },
  });
}

export async function findPendingMatchesByHost(
  hostDiscordId: string,
): Promise<MatchWithPlayers[]> {
  return prisma.match.findMany({
    where: {
      hostDiscordId,
      status: 'PENDING',
    },
    include: {
      players: {
        include: { player: true },
        orderBy: { slot: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function findInProgressMatchesByHost(
  hostDiscordId: string,
): Promise<MatchWithPlayers[]> {
  return prisma.match.findMany({
    where: {
      hostDiscordId,
      status: 'IN_PROGRESS',
    },
    include: {
      players: {
        include: { player: true },
        orderBy: { slot: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export function matchToLobbyPlayers(match: MatchWithPlayers): LobbyPlayer[] {
  return toLobbyPlayers(match);
}

/**
 * Replace the full roster of a PENDING match (Fix Reading edits).
 */
export async function replaceMatchRoster(
  matchId: string,
  players: LobbyPlayer[],
): Promise<MatchWithPlayers> {
  const roster = withNormalizedNicks(players);
  assertValidSlots(roster);
  assertUniqueNicks(roster);

  await ensureHeroesExist();

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await tx.match.findUnique({ where: { id: matchId } });

    if (!existing) {
      throw new MatchServiceError('This match lobby was not found.');
    }

    if (existing.status !== 'PENDING') {
      throw new MatchServiceError('This match can no longer be edited.');
    }

    await tx.matchPlayer.deleteMany({ where: { matchId } });

    const resolved = await resolvePlayersInTx(tx, roster);

    if (resolved.length > 0) {
      await tx.matchPlayer.createMany({
        data: resolved.map((entry) => ({
          matchId,
          playerId: entry.playerId,
          team: entry.team,
          slot: entry.slot,
          heroId: entry.slot,
          result: null,
          isQuitter: false,
        })),
      });
    }

    return tx.match.findUniqueOrThrow({
      where: { id: matchId },
      include: {
        players: {
          include: { player: true },
          orderBy: { slot: 'asc' },
        },
      },
    });
  });

  log.info(
    { matchId, playerCount: roster.length, ...teamCounts(roster) },
    'Match roster replaced',
  );

  return updated;
}

/**
 * Validate roster and flip PENDING → IN_PROGRESS.
 */
export async function startMatch(matchId: string): Promise<MatchWithPlayers> {
  const match = await getMatchById(matchId);

  if (!match) {
    throw new MatchServiceError('This match lobby was not found.');
  }

  if (match.status !== 'PENDING') {
    throw new MatchServiceError('This match has already been started or cancelled.');
  }

  const players = toLobbyPlayers(match);
  assertUniqueNicks(players);

  try {
    validateLobbyPlayers(players);
  } catch (error) {
    if (error instanceof LobbyOcrError) {
      throw new MatchServiceError(error.message);
    }

    throw error;
  }

  const updated = await prisma.match.update({
    where: { id: matchId },
    data: { status: 'IN_PROGRESS' },
    include: {
      players: {
        include: { player: true },
        orderBy: { slot: 'asc' },
      },
    },
  });

  log.info(
    { matchId, playerCount: players.length, ...teamCounts(players) },
    'Match started',
  );

  return updated;
}

/**
 * Flip a PENDING match to CANCELLED (host cancel).
 */
export async function cancelMatch(matchId: string): Promise<MatchWithPlayers> {
  const match = await getMatchById(matchId);

  if (!match) {
    throw new MatchServiceError('This match lobby was not found.');
  }

  if (match.status !== 'PENDING') {
    throw new MatchServiceError('This match can no longer be cancelled.');
  }

  const updated = await prisma.match.update({
    where: { id: matchId },
    data: { status: 'CANCELLED' },
    include: {
      players: {
        include: { player: true },
        orderBy: { slot: 'asc' },
      },
    },
  });

  log.info({ matchId, playerCount: updated.players.length }, 'Match cancelled');

  return updated;
}

export async function cancelStalePendingMatches(
  olderThanMs: number = STALE_PENDING_MS,
): Promise<MatchWithPlayers[]> {
  const cutoff = new Date(Date.now() - olderThanMs);

  const stale = await prisma.match.findMany({
    where: {
      status: 'PENDING',
      createdAt: { lt: cutoff },
    },
    include: {
      players: {
        include: { player: true },
        orderBy: { slot: 'asc' },
      },
    },
  });

  if (stale.length === 0) {
    return [];
  }

  await prisma.match.updateMany({
    where: {
      id: { in: stale.map((match) => match.id) },
      status: 'PENDING',
    },
    data: { status: 'CANCELLED' },
  });

  log.info({ cancelled: stale.length, cutoff: cutoff.toISOString() }, 'Cancelled stale pending matches');

  return stale;
}
