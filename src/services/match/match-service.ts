import type { Match, MatchPlayer, Player, Prisma } from '@prisma/client';
import {
  getGameProfile,
  type GameProfile,
  invalidSlotMessage,
  isSlotInProfile,
  rosterHeroId,
  teamForSlot,
  UnknownGameIdError,
} from '../../domain/game-profile.js';
import { prisma } from '../../lib/prisma.js';
import { createLogger } from '../../lib/logger.js';
import type { LobbyPlayer } from '../lobby/lobby-ocr.js';
import { matchPlayerLockPairKey, reconcileMatchPlayerLocked } from '../lobby/locked-slots.js';
import { normalizeNick } from '../player/player-nick.js';
import {
  assertHeroCatalogReady,
  assertHeroExists,
  HeroCatalogError,
} from '../guild/hero-catalog.js';
import { isLeagueWritable, LEAGUE_ARCHIVED_MESSAGE } from '../league/league.js';
import { getGameProfileForLeague, LeagueNotFoundError } from '../league/league-profile.js';
import {
  EVENT_NOT_ACTIVE_MESSAGE,
  EVENT_NOT_FOUND_MESSAGE,
  isEventWritable,
} from '../event/event.js';

const log = createLogger('match');

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

export type CreatePendingMatchInput = {
  hostDiscordId: string;
  discordChannelId: string;
  players: LobbyPlayer[];
  wc3statsGameId?: string | null;
  bypassHostLobbyCap?: boolean;
  /** Set when roster authority comes from a screenshot at register time. */
  lobbyRosterAuthorityAt?: Date | null;
} & ({ leagueId: string; eventId?: never } | { eventId: string; leagueId?: never });

/** True when the match belongs to an Event (unrated). */
export function isEventMatch(match: { eventId: string | null }): boolean {
  return match.eventId != null;
}

/** Require IHL leagueId; throws for Event matches. */
export function requireLeagueId(match: { leagueId: string | null }): string {
  if (match.leagueId == null) {
    throw new MatchServiceError('This action is only available for league (IHL) matches.');
  }
  return match.leagueId;
}

export type ReplaceMatchRosterOptions = {
  /** Record screenshot/manual edit time so wc3stats cannot overwrite with older data. */
  markLobbyRosterAuthority?: boolean;
};

function mapHeroCatalogError(error: unknown): never {
  if (error instanceof HeroCatalogError) {
    throw new MatchServiceError(error.message);
  }
  throw error;
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

function assertValidSlots(players: LobbyPlayer[], profile: GameProfile): void {
  const seenSlots = new Set<number>();

  for (const player of players) {
    if (!isSlotInProfile(profile, player.slot)) {
      throw new MatchServiceError(invalidSlotMessage(profile));
    }

    if (seenSlots.has(player.slot)) {
      throw new MatchServiceError(`Duplicate slot ${player.slot} found in the lobby.`);
    }

    seenSlots.add(player.slot);
  }
}

function assertBothTeamsOccupied(players: LobbyPlayer[], profile: GameProfile): void {
  const teamA = players.filter((player) => teamForSlot(profile, player.slot) === 1);
  const teamB = players.filter((player) => teamForSlot(profile, player.slot) === 2);

  if (teamA.length === 0 || teamB.length === 0) {
    throw new MatchServiceError(
      `Both ${profile.teamNames[1]} and ${profile.teamNames[2]} need at least one human player.`,
    );
  }
}

async function loadMatchProfile(leagueId: string): Promise<GameProfile> {
  try {
    return await getGameProfileForLeague(leagueId);
  } catch (error) {
    if (error instanceof LeagueNotFoundError) {
      throw new MatchServiceError(error.message);
    }
    throw error;
  }
}

async function loadMatchProfileForTenant(match: {
  leagueId: string | null;
  eventId: string | null;
}): Promise<GameProfile> {
  if (match.leagueId) {
    return loadMatchProfile(match.leagueId);
  }
  if (match.eventId) {
    const event = await prisma.event.findUnique({
      where: { id: match.eventId },
      select: { gameId: true },
    });
    if (!event) {
      throw new MatchServiceError(EVENT_NOT_FOUND_MESSAGE);
    }
    try {
      return getGameProfile(event.gameId);
    } catch (error) {
      if (error instanceof UnknownGameIdError) {
        throw new MatchServiceError(error.message);
      }
      throw error;
    }
  }
  throw new MatchServiceError('Match has no league or event.');
}

/** Public helper: game profile for a league or event match. */
export async function getGameProfileForMatch(match: {
  leagueId: string | null;
  eventId: string | null;
}): Promise<GameProfile> {
  return loadMatchProfileForTenant(match);
}

function toLobbyPlayers(match: MatchWithPlayers): LobbyPlayer[] {
  return match.players
    .map((entry) => ({
      slot: entry.slot,
      nick: normalizeNick(entry.player.username),
      locked: entry.locked === true,
    }))
    .sort((a, b) => a.slot - b.slot);
}

function teamCounts(
  players: LobbyPlayer[],
  profile: GameProfile,
): { teamACount: number; teamBCount: number } {
  const teamACount = players.filter((player) => teamForSlot(profile, player.slot) === 1).length;
  return { teamACount, teamBCount: players.length - teamACount };
}

/**
 * Resolve lobby nicks to Player rows (+ default ratings) with batched queries.
 * Avoids per-player sequential upserts that time out on full 6v6 rosters.
 */
async function resolvePlayersInTx(
  tx: Prisma.TransactionClient,
  players: LobbyPlayer[],
  leagueId: string | null,
  profile: GameProfile,
): Promise<{ playerId: string; slot: number; team: number; heroId: number | null }[]> {
  const sorted = withNormalizedNicks(players).sort((a, b) => a.slot - b.slot);

  if (sorted.length === 0) {
    return [];
  }

  const nicks = sorted.map((player) => player.nick);
  const gameId = profile.gameId;
  const existing = await tx.player.findMany({
    where: {
      gameId,
      OR: nicks.map((nick) => ({
        username: { equals: nick, mode: 'insensitive' as const },
      })),
    },
  });
  const byNick = new Map(existing.map((row) => [normalizeNick(row.username), row]));

  const missingNicks = nicks.filter((nick) => !byNick.has(nick));
  if (missingNicks.length > 0) {
    await tx.player.createMany({
      data: missingNicks.map((username) => ({ username, gameId })),
      skipDuplicates: true,
    });
    const created = await tx.player.findMany({
      where: { gameId, username: { in: missingNicks } },
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
      team: teamForSlot(profile, player.slot),
      heroId: rosterHeroId(profile, player.slot),
    };
  });

  if (leagueId != null) {
    await tx.playerRating.createMany({
      data: resolved.map((entry) => ({ leagueId, playerId: entry.playerId })),
      skipDuplicates: true,
    });

    const withHero = resolved.filter(
      (entry): entry is typeof entry & { heroId: number } => entry.heroId != null,
    );
    if (withHero.length > 0) {
      await tx.playerHeroRating.createMany({
        data: withHero.map((entry) => ({
          leagueId,
          playerId: entry.playerId,
          heroId: entry.heroId,
        })),
        skipDuplicates: true,
      });
    }
  }

  return resolved;
}

export function duplicateWc3statsMatchMessage(matchId: string): string {
  return `That Warcraft lobby is already registered as match ${matchId}.`;
}

export function hostLobbyCapMessage(status: 'PENDING' | 'IN_PROGRESS', matchId: string): string {
  if (status === 'IN_PROGRESS') {
    return `You already have a match in progress (${matchId}). Report or cancel it before opening another lobby.`;
  }

  return `You already have a pending lobby (${matchId}). Cancel it before opening another.`;
}

export async function assertHostLobbyCapInTx(
  tx: Prisma.TransactionClient,
  input: {
    leagueId?: string | null;
    eventId?: string | null;
    hostDiscordId: string;
    bypassHostLobbyCap?: boolean;
  },
): Promise<void> {
  if (input.bypassHostLobbyCap === true) {
    return;
  }

  const tenantWhere =
    input.eventId != null
      ? { eventId: input.eventId }
      : input.leagueId != null
        ? { leagueId: input.leagueId }
        : null;
  if (tenantWhere == null) {
    throw new MatchServiceError('Match has no league or event.');
  }

  const existing = await tx.match.findFirst({
    where: {
      ...tenantWhere,
      hostDiscordId: input.hostDiscordId,
      status: { in: ['PENDING', 'IN_PROGRESS'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });

  if (!existing) {
    return;
  }

  const status = existing.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'PENDING';
  throw new MatchServiceError(hostLobbyCapMessage(status, existing.id));
}

export async function findActiveMatchByWc3statsGameId(
  leagueId: string,
  wc3statsGameId: string,
): Promise<MatchWithPlayers | null> {
  return prisma.match.findFirst({
    where: {
      leagueId,
      wc3statsGameId,
      status: { in: ['PENDING', 'IN_PROGRESS'] },
    },
    include: {
      players: {
        include: { player: true },
        orderBy: { slot: 'asc' },
      },
    },
  });
}

/**
 * Attach a wc3stats game id to an existing PENDING match.
 * Rejects when another PENDING/IN_PROGRESS match already uses that id.
 */
export async function linkMatchWc3statsGameId(
  matchId: string,
  wc3statsGameId: string,
): Promise<MatchWithPlayers> {
  const gameId = wc3statsGameId.trim();
  if (gameId === '') {
    throw new MatchServiceError('This lobby is not linked to a Warcraft game list entry.');
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.match.findUnique({ where: { id: matchId } });

    if (!existing) {
      throw new MatchServiceError('This match lobby was not found.');
    }

    if (existing.status !== 'PENDING') {
      throw new MatchServiceError('This match can no longer be edited.');
    }

    const duplicate = await tx.match.findFirst({
      where: {
        wc3statsGameId: gameId,
        status: { in: ['PENDING', 'IN_PROGRESS'] },
        NOT: { id: matchId },
      },
      select: { id: true },
    });

    if (duplicate) {
      throw new MatchServiceError(duplicateWc3statsMatchMessage(duplicate.id));
    }

    return tx.match.update({
      where: { id: matchId },
      data: { wc3statsGameId: gameId },
      include: {
        players: {
          include: { player: true },
          orderBy: { slot: 'asc' },
        },
      },
    });
  });
}

/**
 * Create a PENDING match immediately on lobby register.
 * Empty roster is allowed (OCR soft-fail / manual fill).
 */
export async function createPendingMatch(
  input: CreatePendingMatchInput,
): Promise<CreatedPendingMatch> {
  const eventId = 'eventId' in input && input.eventId ? input.eventId : null;
  const leagueId = 'leagueId' in input && input.leagueId ? input.leagueId : null;

  if ((eventId == null) === (leagueId == null)) {
    throw new MatchServiceError('Match must belong to exactly one of league or event.');
  }

  let profile: GameProfile;
  if (leagueId) {
    const league = await prisma.league.findUnique({
      where: { id: leagueId },
      select: { status: true },
    });
    if (league && !isLeagueWritable(league)) {
      throw new MatchServiceError(LEAGUE_ARCHIVED_MESSAGE);
    }
    profile = await loadMatchProfile(leagueId);
  } else {
    const event = await prisma.event.findUnique({
      where: { id: eventId! },
      select: { status: true, gameId: true },
    });
    if (!event) {
      throw new MatchServiceError(EVENT_NOT_FOUND_MESSAGE);
    }
    if (!isEventWritable(event)) {
      throw new MatchServiceError(EVENT_NOT_ACTIVE_MESSAGE);
    }
    try {
      profile = getGameProfile(event.gameId);
    } catch (error) {
      if (error instanceof UnknownGameIdError) {
        throw new MatchServiceError(error.message);
      }
      throw error;
    }
  }

  const players = withNormalizedNicks(input.players);
  assertValidSlots(players, profile);
  assertUniqueNicks(players);

  if (profile.heroBinding === 'slot_bound') {
    try {
      await assertHeroCatalogReady();
      for (const player of players) {
        await assertHeroExists(player.slot);
      }
    } catch (error) {
      mapHeroCatalogError(error);
    }
  }

  const wc3statsGameId = input.wc3statsGameId?.trim() || null;

  const created = await prisma.$transaction(async (tx) => {
    await assertHostLobbyCapInTx(tx, {
      leagueId,
      eventId,
      hostDiscordId: input.hostDiscordId,
      bypassHostLobbyCap: input.bypassHostLobbyCap === true,
    });

    if (wc3statsGameId && leagueId) {
      const existing = await tx.match.findFirst({
        where: {
          leagueId,
          wc3statsGameId,
          status: { in: ['PENDING', 'IN_PROGRESS'] },
        },
        select: { id: true },
      });

      if (existing) {
        throw new MatchServiceError(duplicateWc3statsMatchMessage(existing.id));
      }
    }

    const resolved = await resolvePlayersInTx(tx, players, leagueId, profile);

    return tx.match.create({
      data: {
        status: 'PENDING',
        leagueId,
        eventId,
        hostDiscordId: input.hostDiscordId,
        discordChannelId: input.discordChannelId,
        wc3statsGameId,
        lobbyRosterAuthorityAt: input.lobbyRosterAuthorityAt ?? undefined,
        players: {
          create: resolved.map((entry) => ({
            playerId: entry.playerId,
            team: entry.team,
            slot: entry.slot,
            heroId: entry.heroId,
            result: null,
            isQuitter: false,
            isGriefer: false,
          })),
        },
      },
    });
  });

  const { teamACount, teamBCount } = teamCounts(players, profile);

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

/**
 * Soft-lock toggle on a PENDING MatchPlayer seat (no roster rewrite).
 */
export async function setMatchPlayerLocked(
  matchId: string,
  slot: number,
  locked: boolean,
): Promise<MatchWithPlayers> {
  const match = await getMatchById(matchId);
  if (!match) {
    throw new MatchServiceError('This match lobby was not found.');
  }
  if (match.status !== 'PENDING') {
    throw new MatchServiceError('This match can no longer be edited.');
  }

  const profile = await loadMatchProfileForTenant(match);
  if (!isSlotInProfile(profile, slot)) {
    throw new MatchServiceError(invalidSlotMessage(profile));
  }

  const occupant = match.players.find((player) => player.slot === slot);
  if (!occupant) {
    if (locked) {
      throw new MatchServiceError('Nobody in that slot to lock.');
    }
    throw new MatchServiceError(`Slot ${slot} is empty.`);
  }

  await prisma.matchPlayer.update({
    where: {
      matchId_playerId: { matchId, playerId: occupant.playerId },
    },
    data: { locked },
  });

  const updated = await getMatchById(matchId);
  if (!updated) {
    throw new MatchServiceError('This match lobby was not found.');
  }
  return updated;
}

export async function findPendingMatchesByHost(hostDiscordId: string): Promise<MatchWithPlayers[]> {
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
  options: ReplaceMatchRosterOptions = {},
): Promise<MatchWithPlayers> {
  const existingMatch = await prisma.match.findUnique({ where: { id: matchId } });
  if (!existingMatch) {
    throw new MatchServiceError('This match lobby was not found.');
  }

  const profile = await loadMatchProfileForTenant(existingMatch);
  const roster = withNormalizedNicks(players);
  assertValidSlots(roster, profile);
  assertUniqueNicks(roster);

  if (profile.heroBinding === 'slot_bound') {
    try {
      await assertHeroCatalogReady();
      for (const player of roster) {
        await assertHeroExists(player.slot);
      }
    } catch (error) {
      if (error instanceof MatchServiceError) {
        throw error;
      }
      mapHeroCatalogError(error);
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await tx.match.findUnique({ where: { id: matchId } });

    if (!existing) {
      throw new MatchServiceError('This match lobby was not found.');
    }

    if (existing.status !== 'PENDING') {
      throw new MatchServiceError('This match can no longer be edited.');
    }

    const previousRows = await tx.matchPlayer.findMany({
      where: { matchId },
      select: { playerId: true, slot: true, locked: true },
    });
    const previousLockedPairs = new Set(
      previousRows
        .filter((row) => row.locked)
        .map((row) => matchPlayerLockPairKey(row.playerId, row.slot)),
    );
    const incomingLockedBySlot = new Map(
      roster.map((player) => [player.slot, player.locked === true] as const),
    );

    await tx.matchPlayer.deleteMany({ where: { matchId } });

    const resolved = await resolvePlayersInTx(tx, roster, existing.leagueId, profile);

    if (resolved.length > 0) {
      await tx.matchPlayer.createMany({
        data: resolved.map((entry) => ({
          matchId,
          playerId: entry.playerId,
          team: entry.team,
          slot: entry.slot,
          heroId: entry.heroId,
          result: null,
          isQuitter: false,
          isGriefer: false,
          locked: reconcileMatchPlayerLocked(
            previousLockedPairs,
            entry.playerId,
            entry.slot,
            incomingLockedBySlot.get(entry.slot) === true,
          ),
        })),
      });
    }

    if (options.markLobbyRosterAuthority) {
      await tx.match.update({
        where: { id: matchId },
        data: { lobbyRosterAuthorityAt: new Date() },
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
    { matchId, playerCount: roster.length, ...teamCounts(roster, profile) },
    'Match roster replaced',
  );

  return updated;
}

/**
 * Mark manual/screenshot roster authority without changing players (e.g. OCR found nothing).
 */
export async function touchLobbyRosterAuthority(matchId: string): Promise<MatchWithPlayers> {
  const existing = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      players: {
        include: { player: true },
        orderBy: { slot: 'asc' },
      },
    },
  });

  if (!existing) {
    throw new MatchServiceError('This match lobby was not found.');
  }

  if (existing.status !== 'PENDING') {
    throw new MatchServiceError('This match can no longer be edited.');
  }

  return prisma.match.update({
    where: { id: matchId },
    data: { lobbyRosterAuthorityAt: new Date() },
    include: {
      players: {
        include: { player: true },
        orderBy: { slot: 'asc' },
      },
    },
  });
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

  const profile = await loadMatchProfileForTenant(match);
  const players = toLobbyPlayers(match);
  assertUniqueNicks(players);
  assertBothTeamsOccupied(players, profile);

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
    { matchId, playerCount: players.length, ...teamCounts(players, profile) },
    'Match started',
  );

  return updated;
}

/**
 * Flip a PENDING match to CANCELLED (host or match moderator).
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

  log.info(
    { cancelled: stale.length, cutoff: cutoff.toISOString() },
    'Cancelled stale pending matches',
  );

  return stale;
}
