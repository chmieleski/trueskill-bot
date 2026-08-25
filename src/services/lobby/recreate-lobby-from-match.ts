import type { LobbyPlayer } from './lobby-ocr.js';
import { canStartLobby } from './lobby-preview.js';
import { createLogger } from '../../lib/logger.js';
import {
  assertHasMatchModRole,
  attachDiscordMessage,
  createPendingMatch,
  getGameProfileForMatch,
  getMatchById,
  hasMatchModRole,
  isEventMatch,
  MatchServiceError,
  requireLeagueId,
  type MatchWithPlayers,
} from '../match/index.js';
import { matchToLobbyPlayers } from '../match/match-service.js';
import { assertLeagueLobbyCreateChannel } from '../league/league-lobby-channel.js';
import type { GameProfile } from '../../domain/game-profile.js';
import { isLeagueWc3statsImportReady, resolveLeagueConfig } from '../league/league-wc3stats.js';
import { loadLobbyRatingPreview, matchPlayersToRatingEntries } from '../rating/index.js';
import {
  collectNewPlayerSuggestionsForPendingCreate,
  type NewPlayerSuggestion,
} from '../rating/new-player.js';
import { getEventById, isEventWritable, EVENT_NOT_ACTIVE_MESSAGE } from '../event/event.js';

const log = createLogger('recreate-lobby-from-match');

const NOT_VOIDED_MESSAGE =
  'Only a voided completed match can be recreated. Void the match first with /match void.';
const NOT_FOUND_MESSAGE = 'This match was not found.';

export type RecreateLobbyFromMatchInput = {
  actorDiscordId: string;
  memberRoleIds: string[];
  matchModRoleId?: string;
  sourceMatchId: string;
  discordChannelId: string;
};

export type RecreateLobbyFromMatchResult = {
  matchId: string;
  createdAt: Date;
  sourceMatchId: string;
  hostDiscordId: string;
  leagueId: string | null;
  eventId: string | null;
  eventName: string | null;
  players: LobbyPlayer[];
  canStart: boolean;
  wc3statsGameId: string | null;
  wc3statsReady: boolean;
  playerClaimEnabled: boolean;
  ratingPreview: Awaited<ReturnType<typeof loadLobbyRatingPreview>> | undefined;
  profile: GameProfile;
  newPlayerSuggestions: NewPlayerSuggestion[];
};

/**
 * A voided match is CANCELLED but still has completedAt from when it was rated.
 */
function assertVoidedCompletedMatch(match: MatchWithPlayers): void {
  if (match.status !== 'CANCELLED' || !match.completedAt) {
    throw new MatchServiceError(NOT_VOIDED_MESSAGE);
  }
}

/**
 * Create a fresh PENDING lobby from a voided completed match roster (mods only).
 * Pairs with `/match void` when names or seats need correction before re-playing.
 */
export async function recreateLobbyFromVoidedMatch(
  input: RecreateLobbyFromMatchInput,
): Promise<RecreateLobbyFromMatchResult> {
  assertHasMatchModRole({
    actorDiscordId: input.actorDiscordId,
    memberRoleIds: input.memberRoleIds,
    matchModRoleId: input.matchModRoleId,
  });

  const source = await getMatchById(input.sourceMatchId);
  if (!source) {
    throw new MatchServiceError(NOT_FOUND_MESSAGE);
  }

  assertVoidedCompletedMatch(source);

  const players = matchToLobbyPlayers(source);
  const profile = await getGameProfileForMatch(source);
  const canStart = canStartLobby(players, profile);
  const bypassHostLobbyCap = hasMatchModRole({
    actorDiscordId: input.actorDiscordId,
    memberRoleIds: input.memberRoleIds,
    matchModRoleId: input.matchModRoleId,
  });

  if (isEventMatch(source)) {
    const event = await getEventById(source.eventId!);
    if (!event || !isEventWritable(event)) {
      throw new MatchServiceError(EVENT_NOT_ACTIVE_MESSAGE);
    }

    const created = await createPendingMatch({
      eventId: source.eventId!,
      hostDiscordId: source.hostDiscordId,
      discordChannelId: input.discordChannelId,
      players,
      wc3statsGameId: source.wc3statsGameId,
      bypassHostLobbyCap,
    });

    log.info(
      {
        sourceMatchId: source.id,
        matchId: created.matchId,
        eventId: source.eventId,
        actorDiscordId: input.actorDiscordId,
        playerCount: players.length,
      },
      'Event lobby recreated from voided match',
    );

    return {
      matchId: created.matchId,
      createdAt: created.createdAt,
      sourceMatchId: source.id,
      hostDiscordId: source.hostDiscordId,
      leagueId: null,
      eventId: source.eventId,
      eventName: event.name,
      players,
      canStart,
      wc3statsGameId: source.wc3statsGameId,
      wc3statsReady: false,
      playerClaimEnabled: false,
      ratingPreview: undefined,
      profile,
      newPlayerSuggestions: [],
    };
  }

  const leagueId = requireLeagueId(source);
  await assertLeagueLobbyCreateChannel(leagueId, input.discordChannelId);

  const leagueConfig = await resolveLeagueConfig(leagueId);
  const wc3statsReady = isLeagueWc3statsImportReady(leagueConfig);

  const created = await createPendingMatch({
    leagueId,
    hostDiscordId: source.hostDiscordId,
    discordChannelId: input.discordChannelId,
    players,
    wc3statsGameId: source.wc3statsGameId,
    bypassHostLobbyCap,
  });

  const match = await getMatchById(created.matchId);
  const ratingPreview = match
    ? await loadLobbyRatingPreview(leagueId, matchPlayersToRatingEntries(match.players))
    : undefined;

  const newPlayerSuggestions = match
    ? await collectNewPlayerSuggestionsForPendingCreate({
        leagueId,
        matchId: match.id,
        players: match.players.map((player) => ({
          playerId: player.playerId,
          username: player.player.username,
        })),
      })
    : [];

  log.info(
    {
      sourceMatchId: source.id,
      matchId: created.matchId,
      actorDiscordId: input.actorDiscordId,
      playerCount: players.length,
    },
    'Lobby recreated from voided match',
  );

  return {
    matchId: created.matchId,
    createdAt: created.createdAt,
    sourceMatchId: source.id,
    hostDiscordId: source.hostDiscordId,
    leagueId,
    eventId: null,
    eventName: null,
    players,
    canStart,
    wc3statsGameId: source.wc3statsGameId,
    wc3statsReady,
    playerClaimEnabled: leagueConfig.lobbyPlayerClaimEnabled,
    ratingPreview,
    profile,
    newPlayerSuggestions,
  };
}

/** Persist the Discord message id on a recreated PENDING match. */
export async function attachRecreatedLobbyMessage(
  matchId: string,
  messageId: string,
  channelId: string,
): Promise<void> {
  await attachDiscordMessage(matchId, messageId, channelId);
}
