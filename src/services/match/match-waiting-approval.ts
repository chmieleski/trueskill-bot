import type { Prisma } from '@prisma/client';
import { rosterHeroId, teamForSlot, type GameProfile } from '../../domain/game-profile.js';
import {
  inferSuggestedWinner,
  lobbyPlayersFromWos2Report,
  parseWos2BotReport,
  Wos2BotReportParseError,
  Wos2ReportRosterError,
  type Wos2BotReport,
} from '../../games/warcraft3_wos/index.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import type { LobbyPlayer } from '../lobby/lobby-ocr.js';
import { isLeagueWritable, LEAGUE_ARCHIVED_MESSAGE } from '../league/league.js';
import { getGameProfileForLeague } from '../league/league-profile.js';
import { normalizeNick } from '../player/player-nick.js';
import { getMatchById, MatchServiceError } from './match-service.js';
import { assertWos2ReportExternalIdUnused, persistWos2MatchStats } from './match-stats-upload.js';

const log = createLogger('match-waiting-approval');

/** Sentinel match id for pre-create duplicate checks (excluded from the search). */
const WOS_INGEST_EXTERNAL_ID_PRECHECK_MATCH_ID = '__ingest_precheck__';

export type IngestWosReportForApprovalInput = {
  leagueId: string;
  guildId: string;
  gameId: string;
  matchApprovalChannelId: string;
  hostDiscordId: string; // bot user id / clientId
  reportText: string;
};

export type IngestWosReportForApprovalResult = {
  matchId: string;
  status: 'WAITING_FOR_APPROVAL';
  externalId: string;
  suggestedWinner: 1 | 2 | null;
  /** Set by caller after Discord post, or null if post skipped/failed */
  discordMessageUrl: string | null;
};

function mapParseError(error: unknown): never {
  if (error instanceof Wos2BotReportParseError) {
    throw new MatchServiceError(error.message);
  }
  if (error instanceof Wos2ReportRosterError) {
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

/**
 * Resolve lobby nicks to Player rows (+ default ratings) with batched queries.
 * Mirrors createPendingMatch's resolvePlayersInTx (kept local to avoid exporting internals).
 */
async function resolvePlayersInTx(
  tx: Prisma.TransactionClient,
  players: LobbyPlayer[],
  leagueId: string,
  profile: GameProfile,
): Promise<
  { playerId: string; slot: number; team: number; heroId: number | null; isQuitter: boolean }[]
> {
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
      isQuitter: player.isQuitter === true,
    };
  });

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

  return resolved;
}

/** Prefill isQuitter from report `left` flags, matched by normalized nick. */
function applyQuittersFromReport(players: LobbyPlayer[], report: Wos2BotReport): LobbyPlayer[] {
  const leftByNick = new Map(
    report.players.map((player) => [normalizeNick(player.name), player.left === true]),
  );
  return players.map((player) => ({
    ...player,
    isQuitter: leftByNick.get(normalizeNick(player.nick)) === true,
  }));
}

/**
 * Create a WAITING_FOR_APPROVAL match with roster (no Discord post, no PENDING hop).
 */
async function createWaitingApprovalMatch(input: {
  leagueId: string;
  hostDiscordId: string;
  discordChannelId: string;
  approvalWinnerTeam: 1 | 2 | null;
  players: LobbyPlayer[];
  profile: GameProfile;
}): Promise<{ matchId: string }> {
  const players = withNormalizedNicks(input.players);
  assertUniqueNicks(players);

  const created = await prisma.$transaction(async (tx) => {
    const resolved = await resolvePlayersInTx(tx, players, input.leagueId, input.profile);

    return tx.match.create({
      data: {
        status: 'WAITING_FOR_APPROVAL',
        leagueId: input.leagueId,
        hostDiscordId: input.hostDiscordId,
        discordChannelId: input.discordChannelId,
        discordMessageId: null,
        approvalWinnerTeam: input.approvalWinnerTeam,
        players: {
          create: resolved.map((entry) => ({
            playerId: entry.playerId,
            team: entry.team,
            slot: entry.slot,
            heroId: entry.heroId,
            result: null,
            isQuitter: entry.isQuitter === true,
            isGriefer: false,
          })),
        },
      },
    });
  });

  log.info(
    {
      matchId: created.id,
      leagueId: input.leagueId,
      playerCount: players.length,
      approvalWinnerTeam: input.approvalWinnerTeam,
    },
    'Waiting-for-approval match created',
  );

  return { matchId: created.id };
}

/**
 * Ingest a raw WOS2 bot report into a new WAITING_FOR_APPROVAL match + stats.
 * Does not post to Discord (caller attaches the message afterward).
 */
export async function ingestWosReportForApproval(
  input: IngestWosReportForApprovalInput,
): Promise<IngestWosReportForApprovalResult> {
  const league = await prisma.league.findUnique({
    where: { id: input.leagueId },
    select: { status: true },
  });
  if (league && !isLeagueWritable(league)) {
    throw new MatchServiceError(LEAGUE_ARCHIVED_MESSAGE);
  }

  const profile = await getGameProfileForLeague(input.leagueId);
  if (profile.postMatchStats !== 'wos2_bot_v1') {
    throw new MatchServiceError('This game does not accept match stats reports.');
  }

  const matchApprovalChannelId = input.matchApprovalChannelId.trim();
  if (matchApprovalChannelId === '') {
    throw new MatchServiceError('Match approval channel is not configured.');
  }

  let report: Wos2BotReport;
  try {
    report = parseWos2BotReport(input.reportText);
  } catch (error) {
    mapParseError(error);
  }

  let lobbyPlayers: LobbyPlayer[];
  try {
    lobbyPlayers = lobbyPlayersFromWos2Report(report, profile);
  } catch (error) {
    mapParseError(error);
  }

  const suggested = inferSuggestedWinner(report);
  const approvalWinnerTeam = suggested?.team ?? null;
  const players = applyQuittersFromReport(lobbyPlayers, report);

  // Reject duplicates before create so we never leave an orphan WAITING_FOR_APPROVAL match.
  await assertWos2ReportExternalIdUnused(
    report.externalId,
    WOS_INGEST_EXTERNAL_ID_PRECHECK_MATCH_ID,
  );

  const { matchId } = await createWaitingApprovalMatch({
    leagueId: input.leagueId,
    hostDiscordId: input.hostDiscordId,
    discordChannelId: matchApprovalChannelId,
    approvalWinnerTeam,
    players,
    profile,
  });

  const match = await getMatchById(matchId);
  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }

  let externalId: string;
  try {
    ({ externalId } = await persistWos2MatchStats({
      matchId,
      actorDiscordId: input.hostDiscordId,
      rawText: input.reportText,
      report,
      matchPlayers: match.players,
    }));
  } catch (error) {
    // Avoid leaving an orphan WAITING_FOR_APPROVAL match with no (or partial) stats.
    try {
      await prisma.match.delete({ where: { id: matchId } });
      log.warn({ matchId, err: error }, 'Deleted waiting match after persist failed');
    } catch (cleanupError) {
      log.error(
        { matchId, err: cleanupError, persistError: error },
        'Failed to delete waiting match after persist failure',
      );
    }
    throw error;
  }

  return {
    matchId,
    status: 'WAITING_FOR_APPROVAL',
    externalId,
    suggestedWinner: approvalWinnerTeam,
    discordMessageUrl: null,
  };
}

/** Attach the Discord approval message id after posting (channel already set on create). */
export async function attachApprovalDiscordMessage(
  matchId: string,
  discordMessageId: string,
): Promise<void> {
  await prisma.match.update({
    where: { id: matchId },
    data: { discordMessageId },
  });

  log.debug({ matchId, discordMessageId }, 'Approval Discord message attached');
}
