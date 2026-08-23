import type { LobbyPlayer } from './lobby-ocr.js';
import { canStartLobby } from './lobby-preview.js';
import { createLogger } from '../../lib/logger.js';
import {
  assertHasMatchModRole,
  attachDiscordMessage,
  createPendingMatch,
  getMatchById,
  hasMatchModRole,
  MatchServiceError,
  type MatchWithPlayers,
} from '../match/index.js';
import { matchToLobbyPlayers } from '../match/match-service.js';
import { assertLeagueLobbyCreateChannel } from '../league/league-lobby-channel.js';
import { getGameProfileForLeague } from '../league/league-profile.js';
import type { GameProfile } from '../../domain/game-profile.js';
import { isLeagueWc3statsImportReady, resolveLeagueConfig } from '../league/league-wc3stats.js';
import { loadLobbyRatingPreview, matchPlayersToRatingEntries } from '../rating/index.js';
import {
  collectNewPlayerSuggestionsForPendingCreate,
  type NewPlayerSuggestion,
} from '../rating/new-player.js';

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
  leagueId: string;
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
  await assertLeagueLobbyCreateChannel(source.leagueId, input.discordChannelId);

  const players = matchToLobbyPlayers(source);
  const profile = await getGameProfileForLeague(source.leagueId);
  const leagueConfig = await resolveLeagueConfig(source.leagueId);
  const wc3statsReady = isLeagueWc3statsImportReady(leagueConfig);
  const canStart = canStartLobby(players, profile);

  const created = await createPendingMatch({
    leagueId: source.leagueId,
    hostDiscordId: source.hostDiscordId,
    discordChannelId: input.discordChannelId,
    players,
    wc3statsGameId: source.wc3statsGameId,
    bypassHostLobbyCap: hasMatchModRole({
      actorDiscordId: input.actorDiscordId,
      memberRoleIds: input.memberRoleIds,
      matchModRoleId: input.matchModRoleId,
    }),
  });

  const match = await getMatchById(created.matchId);
  const ratingPreview = match
    ? await loadLobbyRatingPreview(source.leagueId, matchPlayersToRatingEntries(match.players))
    : undefined;

  const newPlayerSuggestions = match
    ? await collectNewPlayerSuggestionsForPendingCreate({
        leagueId: match.leagueId,
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
    leagueId: source.leagueId,
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
