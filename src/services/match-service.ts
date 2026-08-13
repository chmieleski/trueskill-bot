import type { Match, MatchPlayer, Player, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { createLogger } from '../lib/logger.js';
import { LobbyOcrError, validateLobbyPlayers, type LobbyPlayer } from './lobby-ocr.js';

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

function assertUniqueNicks(players: LobbyPlayer[]): void {
  const seen = new Set<string>();

  for (const player of players) {
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
      nick: entry.player.username,
    }))
    .sort((a, b) => a.slot - b.slot);
}

function teamCounts(players: LobbyPlayer[]): { teamACount: number; teamBCount: number } {
  const teamACount = players.filter((player) => player.slot <= TEAM_A_MAX_SLOT).length;
  return { teamACount, teamBCount: players.length - teamACount };
}

async function resolvePlayersInTx(
  tx: Prisma.TransactionClient,
  players: LobbyPlayer[],
): Promise<{ playerId: string; slot: number; team: number }[]> {
  const sorted = [...players].sort((a, b) => a.slot - b.slot);
  const resolved: { playerId: string; slot: number; team: number }[] = [];

  for (const player of sorted) {
    const dbPlayer = await tx.player.upsert({
      where: { username: player.nick },
      create: { username: player.nick },
      update: {},
    });

    await tx.playerRating.upsert({
      where: { playerId: dbPlayer.id },
      create: { playerId: dbPlayer.id },
      update: {},
    });

    resolved.push({
      playerId: dbPlayer.id,
      slot: player.slot,
      team: player.slot <= TEAM_A_MAX_SLOT ? 1 : 2,
    });
  }

  return resolved;
}

/**
 * Create a PENDING match immediately on lobby register.
 * Empty roster is allowed (OCR soft-fail / manual fill).
 */
export async function createPendingMatch(
  input: CreatePendingMatchInput,
): Promise<CreatedPendingMatch> {
  assertValidSlots(input.players);
  assertUniqueNicks(input.players);

  const created = await prisma.$transaction(async (tx) => {
    const resolved = await resolvePlayersInTx(tx, input.players);

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

  const { teamACount, teamBCount } = teamCounts(input.players);

  log.info(
    {
      matchId: created.id,
      hostDiscordId: input.hostDiscordId,
      playerCount: input.players.length,
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
    playerCount: input.players.length,
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
  assertValidSlots(players);
  assertUniqueNicks(players);

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await tx.match.findUnique({ where: { id: matchId } });

    if (!existing) {
      throw new MatchServiceError('This match lobby was not found.');
    }

    if (existing.status !== 'PENDING') {
      throw new MatchServiceError('This match can no longer be edited.');
    }

    await tx.matchPlayer.deleteMany({ where: { matchId } });

    const resolved = await resolvePlayersInTx(tx, players);

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
    { matchId, playerCount: players.length, ...teamCounts(players) },
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
