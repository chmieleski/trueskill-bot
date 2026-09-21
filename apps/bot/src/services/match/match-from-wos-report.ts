import {
  lobbyPlayersFromWos2Report,
  parseWos2BotReport,
  Wos2BotReportParseError,
  Wos2ReportRosterError,
} from '../../games/warcraft3_wos/index.js';
import type { GameProfile } from '../../domain/game-profile.js';
import { getGameProfile } from '../../domain/game-profile.js';
import type { LobbyPlayer } from '../lobby/lobby-ocr.js';
import { canStartLobby } from '../lobby/lobby-preview.js';
import {
  createPendingMatch,
  getMatchById,
  MatchServiceError,
  replaceMatchRoster,
  type MatchWithPlayers,
} from './match-service.js';
import { assertCanCreateMatch, assertCanManageMatch } from './match-auth.js';
import { persistWos2MatchStats } from './match-stats-upload.js';
import { resolveGuildConfig } from '../guild/index.js';
import { getGameProfileForLeague } from '../league/league-profile.js';
import { isEventWritable, EVENT_NOT_ACTIVE_MESSAGE } from '../event/event.js';
import { isLeagueWritable, LEAGUE_ARCHIVED_MESSAGE } from '../league/league.js';
import { prisma } from '../../lib/prisma.js';

export type FillLobbyFromWos2ReportInput = {
  guildId: string;
  leagueId?: string;
  eventId?: string;
  hostDiscordId: string;
  discordChannelId: string;
  memberRoleIds: string[];
  matchModRoleId: string | undefined;
  rawText: string;
  existingMatchId?: string;
  bypassHostLobbyCap?: boolean;
};

export type FillLobbyFromWos2ReportResult = {
  matchId: string;
  createdAt: Date;
  players: LobbyPlayer[];
  canStart: boolean;
  profile: GameProfile;
  match: MatchWithPlayers;
  warnings: string[];
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

async function resolveProfile(input: FillLobbyFromWos2ReportInput): Promise<GameProfile> {
  if (input.leagueId) {
    return getGameProfileForLeague(input.leagueId);
  }
  if (!input.eventId) {
    throw new MatchServiceError('League or event is required.');
  }
  const event = await prisma.event.findUnique({
    where: { id: input.eventId },
    select: { gameId: true, status: true },
  });
  if (!event) {
    throw new MatchServiceError('This event was not found.');
  }
  if (!isEventWritable(event)) {
    throw new MatchServiceError(EVENT_NOT_ACTIVE_MESSAGE);
  }
  return getGameProfile(event.gameId);
}

/** Fill a PENDING lobby roster and stats from a WOS2 bot report. Does not start or complete. */
export async function fillLobbyFromWos2Report(
  input: FillLobbyFromWos2ReportInput,
): Promise<FillLobbyFromWos2ReportResult> {
  const guildConfig = await resolveGuildConfig(input.guildId);
  const profile = await resolveProfile(input);

  if (profile.postMatchStats !== 'wos2_bot_v1') {
    throw new MatchServiceError('This game does not accept match stats reports.');
  }

  let report;
  try {
    report = parseWos2BotReport(input.rawText);
  } catch (error) {
    mapParseError(error);
  }

  let players: LobbyPlayer[];
  try {
    players = lobbyPlayersFromWos2Report(report, profile);
  } catch (error) {
    mapParseError(error);
  }

  if (!canStartLobby(players, profile)) {
    throw new MatchServiceError('Both teams must have at least one player in the report.');
  }

  let matchId = input.existingMatchId;
  let createdAt: Date;

  if (matchId) {
    const existing = await getMatchById(matchId);
    if (!existing) {
      throw new MatchServiceError('This match was not found.');
    }
    if (existing.status !== 'PENDING') {
      throw new MatchServiceError('Report from file is only available on a pending lobby.');
    }

    assertCanManageMatch({
      hostDiscordId: existing.hostDiscordId,
      actorDiscordId: input.hostDiscordId,
      memberRoleIds: input.memberRoleIds,
      matchModRoleId: input.matchModRoleId,
    });

    const updated = await replaceMatchRoster(matchId, players);
    createdAt = updated.createdAt;
  } else {
    assertCanCreateMatch({
      memberRoleIds: input.memberRoleIds,
      matchCreateRoleId: guildConfig.matchCreateRoleId,
    });

    if (input.leagueId) {
      const league = await prisma.league.findUnique({
        where: { id: input.leagueId },
        select: { status: true },
      });
      if (league && !isLeagueWritable(league)) {
        throw new MatchServiceError(LEAGUE_ARCHIVED_MESSAGE);
      }
    }

    const created = await createPendingMatch(
      input.leagueId != null
        ? {
            leagueId: input.leagueId,
            hostDiscordId: input.hostDiscordId,
            discordChannelId: input.discordChannelId,
            players,
            bypassHostLobbyCap: input.bypassHostLobbyCap === true,
          }
        : {
            eventId: input.eventId!,
            hostDiscordId: input.hostDiscordId,
            discordChannelId: input.discordChannelId,
            players,
            bypassHostLobbyCap: input.bypassHostLobbyCap === true,
          },
    );
    matchId = created.matchId;
    createdAt = created.createdAt;
  }

  const match = await getMatchById(matchId);
  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }

  const { warnings } = await persistWos2MatchStats({
    matchId,
    actorDiscordId: input.hostDiscordId,
    rawText: input.rawText,
    report,
    matchPlayers: match.players,
  });

  const refreshed = await getMatchById(matchId);
  if (!refreshed) {
    throw new MatchServiceError('This match was not found.');
  }

  return {
    matchId,
    createdAt,
    players,
    canStart: canStartLobby(players, profile),
    profile,
    match: refreshed,
    warnings,
  };
}
