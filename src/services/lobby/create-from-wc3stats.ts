import type { LobbyPlayer } from './lobby-ocr.js';
import { allowsEmptyMatchOnWc3statsFailure, assertLeagueAllowsWc3statsImport } from './register-lobby-source.js';
import { canStartLobby } from './lobby-preview.js';
import { nickForDiscordId } from './lobby-identity.js';
import { createLogger } from '../../lib/logger.js';
import {
  assertCanCreateMatch,
  attachDiscordMessage,
  createPendingMatch,
  getMatchById,
  hasMatchModRole,
  MatchServiceError,
} from '../match/index.js';
import {
  isLeagueWc3statsImportReady,
  resolveLeagueConfig,
} from '../league/league-wc3stats.js';
import { getGameProfileForLeague } from '../league/league-profile.js';
import type { GameProfile } from '../../domain/game-profile.js';
import { resolveGuildConfig } from '../guild/index.js';
import {
  importWc3statsLobby,
  loadLeagueWc3statsHeroSlotMap,
} from '../wc3stats/index.js';
import {
  loadLobbyRatingPreview,
  matchPlayersToRatingEntries,
} from '../rating/index.js';

const log = createLogger('create-from-wc3stats');

export type CreateMatchFromWc3statsInput = {
  guildId: string;
  leagueId: string;
  hostDiscordId: string;
  discordChannelId: string;
  wc3statsId: number;
  memberRoleIds: string[];
};

export type CreateMatchFromWc3statsResult = {
  matchId: string;
  createdAt: Date;
  players: LobbyPlayer[];
  canStart: boolean;
  wc3statsGameId: string | null;
  wc3statsUnavailable: boolean;
  wc3statsReady: boolean;
  playerClaimEnabled: boolean;
  ratingPreview: Awaited<ReturnType<typeof loadLobbyRatingPreview>> | undefined;
  profile: GameProfile;
};

/**
 * Create a PENDING match from a known wc3stats lobby id.
 * Same create_role + import rules as `/register_lobby` with `wc3stats_id`.
 */
export async function createMatchFromWc3statsLobby(
  input: CreateMatchFromWc3statsInput,
): Promise<CreateMatchFromWc3statsResult> {
  const guildConfig = await resolveGuildConfig(input.guildId);
  assertCanCreateMatch({
    memberRoleIds: input.memberRoleIds,
    matchCreateRoleId: guildConfig.matchCreateRoleId,
  });

  await assertLeagueAllowsWc3statsImport(input.leagueId);
  const leagueConfig = await resolveLeagueConfig(input.leagueId);
  const profile = await getGameProfileForLeague(input.leagueId);
  const wc3statsReady = isLeagueWc3statsImportReady(leagueConfig);
  if (!wc3statsReady || !leagueConfig.wc3statsMapPattern) {
    throw new MatchServiceError('Warcraft lobby import is not configured for this league.');
  }

  let hostNick: string | null = null;
  try {
    hostNick = await nickForDiscordId(input.hostDiscordId, profile.gameId);
  } catch (error) {
    if (!(error instanceof MatchServiceError)) {
      throw error;
    }
  }

  const slotMap = await loadLeagueWc3statsHeroSlotMap(input.leagueId);

  let players: LobbyPlayer[] = [];
  let wc3statsGameId: string | null = null;
  let wc3statsUnavailable = false;

  const imported = await importWc3statsLobby({
    wc3statsId: input.wc3statsId,
    hostNick,
    requireNickInLobby: false,
    slotMap,
    mapPattern: leagueConfig.wc3statsMapPattern,
    mapSha1: leagueConfig.wc3statsMapSha1,
  });

  if (!imported.ok) {
    if (!allowsEmptyMatchOnWc3statsFailure(imported.code)) {
      throw new MatchServiceError(imported.message);
    }
    if (imported.code === 'unavailable') {
      wc3statsUnavailable = true;
    }
    log.warn(
      { code: imported.code, message: imported.message, wc3statsId: input.wc3statsId },
      'wc3stats import skipped; creating Discord lobby',
    );
  } else {
    wc3statsGameId = imported.gameId;
    players = imported.roster.usable ? imported.roster.players : [];
  }

  // Prefer binding the prompted id even when detail import soft-failed.
  if (!wc3statsGameId) {
    wc3statsGameId = String(input.wc3statsId);
  }

  const canStart = canStartLobby(players, profile);
  const created = await createPendingMatch({
    leagueId: input.leagueId,
    hostDiscordId: input.hostDiscordId,
    discordChannelId: input.discordChannelId,
    players,
    wc3statsGameId,
    bypassHostLobbyCap: hasMatchModRole({
      actorDiscordId: input.hostDiscordId,
      memberRoleIds: input.memberRoleIds,
      matchModRoleId: guildConfig.matchModRoleId,
    }),
  });

  const match = await getMatchById(created.matchId);
  const ratingPreview = match
    ? await loadLobbyRatingPreview(input.leagueId, matchPlayersToRatingEntries(match.players))
    : undefined;

  return {
    matchId: created.matchId,
    createdAt: created.createdAt,
    players,
    canStart,
    wc3statsGameId,
    wc3statsUnavailable,
    wc3statsReady,
    playerClaimEnabled: leagueConfig.lobbyPlayerClaimEnabled,
    ratingPreview,
    profile,
  };
}

/**
 * Persist the Discord message id on a newly created PENDING match.
 */
export async function attachCreatedMatchMessage(
  matchId: string,
  messageId: string,
  channelId: string,
): Promise<void> {
  await attachDiscordMessage(matchId, messageId, channelId);
}
