import type { Client } from 'discord.js';
import {
  isLeagueWc3statsImportReady,
  resolveLeagueConfig,
  type ResolvedLeagueConfig,
} from '../league/league-wc3stats.js';
import { getGameProfileForLeague, LeagueNotFoundError } from '../league/league-profile.js';
import { assertCanManageMatch } from '../match/match-auth.js';
import {
  getMatchByDiscordMessageId,
  getMatchById,
  linkMatchWc3statsGameId,
  matchToLobbyPlayers,
  MatchServiceError,
  replaceMatchRoster,
  type MatchWithPlayers,
} from '../match/match-service.js';
import {
  importWc3statsLobby,
  type ImportWc3statsLobbyResult,
} from '../wc3stats/wc3stats-resolve.js';
import { applyWc3statsRefresh } from '../wc3stats/wc3stats-roster.js';
import {
  isWc3statsRosterFresh,
  wc3statsStaleRefreshMessage,
} from '../wc3stats/wc3stats-freshness.js';
import { loadLeagueWc3statsHeroSlotMap } from '../wc3stats/wc3stats-slot-map.js';
import { syncLobbyDiscordMessage, type LobbyActionResult } from './discord-sync.js';
import { nickForDiscordId } from './lobby-identity.js';
import { assertLeagueAllowsWc3statsImport } from './register-lobby-source.js';

const NOT_FOUND_MESSAGE = 'This match lobby was not found. Run /register_lobby again.';
const NOT_EDITABLE_MESSAGE = 'This match can no longer be edited.';
const WC3STATS_NOT_LINKED_MESSAGE = 'This lobby is not linked to a Warcraft game list entry.';
const WC3STATS_IMPORT_DISABLED_MESSAGE = 'Warcraft lobby import is disabled.';
const WC3STATS_REFRESH_WAIT_MESSAGE = 'Wait a few seconds before refreshing again.';
const WC3STATS_REFRESH_KEPT_MESSAGE =
  'wc3stats still has no player list. Your current roster was kept.';
const LOBBY_UPDATED_MESSAGE = 'Lobby updated.';

const REFRESH_DEBOUNCE_MS = 15_000;
const lastRefreshAtByMatchId = new Map<string, number>();

export interface RefreshLobbyResult extends LobbyActionResult {
  keptExisting: boolean;
  warning?: string;
  boundNow: boolean;
  message: string;
}

function refreshResultMessage(input: {
  boundNow: boolean;
  gameId?: string | null;
  warning?: string;
}): string {
  const parts: string[] = [];
  if (input.boundNow && input.gameId) {
    parts.push(`Linked Warcraft lobby \`${input.gameId}\`.`);
  }
  if (input.warning) {
    parts.push(input.warning);
  }
  return parts.join(' ') || LOBBY_UPDATED_MESSAGE;
}

type SuccessfulWc3statsImport = Extract<ImportWc3statsLobbyResult, { ok: true }>;

async function profileGameIdForLeague(leagueId: string): Promise<string> {
  try {
    const profile = await getGameProfileForLeague(leagueId);
    return profile.gameId;
  } catch (error) {
    if (error instanceof LeagueNotFoundError) {
      throw new MatchServiceError(error.message);
    }
    throw error;
  }
}

async function assertWc3statsImportReady(leagueId: string): Promise<ResolvedLeagueConfig> {
  await assertLeagueAllowsWc3statsImport(leagueId);
  const resolved = await resolveLeagueConfig(leagueId);
  if (!isLeagueWc3statsImportReady(resolved)) {
    throw new MatchServiceError(WC3STATS_IMPORT_DISABLED_MESSAGE);
  }
  return resolved;
}

async function importAndMaybeLinkWc3stats(input: {
  match: MatchWithPlayers;
  wc3statsId?: number | null;
  leagueConfig: ResolvedLeagueConfig;
}): Promise<{ match: MatchWithPlayers; imported: SuccessfulWc3statsImport; boundNow: boolean }> {
  const explicitId = input.wc3statsId ?? null;
  const storedId = input.match.wc3statsGameId?.trim() || null;
  let boundNow = false;
  let working = input.match;
  const slotMap = await loadLeagueWc3statsHeroSlotMap(input.match.leagueId);

  if (explicitId) {
    const imported = await importWc3statsLobby({
      wc3statsId: explicitId,
      slotMap,
      mapPattern: input.leagueConfig.wc3statsMapPattern!,
      mapSha1: input.leagueConfig.wc3statsMapSha1,
    });
    if (!imported.ok) {
      throw new MatchServiceError(imported.message);
    }

    if (storedId !== imported.gameId) {
      working = await linkMatchWc3statsGameId(working.id, imported.gameId);
      boundNow = true;
    }

    return { match: working, imported, boundNow };
  }

  if (storedId) {
    const wc3statsId = Number(storedId);
    if (!Number.isInteger(wc3statsId) || wc3statsId <= 0) {
      throw new MatchServiceError(WC3STATS_NOT_LINKED_MESSAGE);
    }

    const imported = await importWc3statsLobby({
      wc3statsId,
      slotMap,
      mapPattern: input.leagueConfig.wc3statsMapPattern!,
      mapSha1: input.leagueConfig.wc3statsMapSha1,
    });
    if (!imported.ok) {
      throw new MatchServiceError(imported.message);
    }

    return { match: working, imported, boundNow: false };
  }

  const hostNick = await nickForDiscordId(
    working.hostDiscordId,
    await profileGameIdForLeague(working.leagueId),
  );
  const imported = await importWc3statsLobby({
    hostNick,
    requireNickInLobby: true,
    slotMap,
    mapPattern: input.leagueConfig.wc3statsMapPattern!,
    mapSha1: input.leagueConfig.wc3statsMapSha1,
  });
  if (!imported.ok) {
    throw new MatchServiceError(imported.message);
  }

  working = await linkMatchWc3statsGameId(working.id, imported.gameId);
  return { match: working, imported, boundNow: true };
}

/**
 * Host/mod Refresh of a PENDING lobby. Links a live UDBR game when none is stored yet
 * (host Discord must be linked with /link and seated in that lobby, or pass wc3stats_id).
 */
export async function refreshLobbyFromWc3stats(input: {
  client: Client;
  actorDiscordId: string;
  memberRoleIds: string[];
  matchModRoleId?: string;
  messageId?: string;
  matchId?: string | null;
  wc3statsId?: number | null;
  guildId?: string | null;
}): Promise<RefreshLobbyResult> {
  const match = input.messageId
    ? await getMatchByDiscordMessageId(input.messageId)
    : input.matchId
      ? await getMatchById(input.matchId)
      : null;

  if (!match) {
    throw new MatchServiceError(NOT_FOUND_MESSAGE);
  }

  if (match.status !== 'PENDING') {
    throw new MatchServiceError(NOT_EDITABLE_MESSAGE);
  }

  await assertLeagueAllowsWc3statsImport(match.leagueId);

  assertCanManageMatch({
    hostDiscordId: match.hostDiscordId,
    actorDiscordId: input.actorDiscordId,
    memberRoleIds: input.memberRoleIds,
    matchModRoleId: input.matchModRoleId,
  });

  const explicitId = input.wc3statsId ?? null;
  const storedId = match.wc3statsGameId?.trim() || null;

  const leagueConfig = await assertWc3statsImportReady(match.leagueId);

  if (!explicitId && !storedId) {
    await nickForDiscordId(match.hostDiscordId, await profileGameIdForLeague(match.leagueId));
  }

  const lastRefreshAt = lastRefreshAtByMatchId.get(match.id);
  if (lastRefreshAt !== undefined && Date.now() - lastRefreshAt < REFRESH_DEBOUNCE_MS) {
    throw new MatchServiceError(WC3STATS_REFRESH_WAIT_MESSAGE);
  }
  lastRefreshAtByMatchId.set(match.id, Date.now());

  const {
    match: linked,
    imported,
    boundNow,
  } = await importAndMaybeLinkWc3stats({
    match,
    wc3statsId: input.wc3statsId,
    leagueConfig,
  });

  const current = matchToLobbyPlayers(linked);
  const applied = applyWc3statsRefresh(current, imported.roster);
  const gameId = linked.wc3statsGameId;
  const rosterFresh = isWc3statsRosterFresh({
    rosterObservedAt: imported.rosterObservedAt,
    lobbyRosterAuthorityAt: linked.lobbyRosterAuthorityAt,
  });

  if (!rosterFresh && !applied.keptExisting) {
    const staleMessage = wc3statsStaleRefreshMessage({
      rosterObservedAt: imported.rosterObservedAt,
      lobbyRosterAuthorityAt: linked.lobbyRosterAuthorityAt,
    });
    await syncLobbyDiscordMessage(input.client, linked, 'pending');
    return {
      match: linked,
      players: current,
      keptExisting: true,
      warning: staleMessage,
      boundNow,
      message: refreshResultMessage({
        boundNow,
        gameId,
        warning: staleMessage,
      }),
    };
  }

  if (applied.keptExisting) {
    await syncLobbyDiscordMessage(input.client, linked, 'pending');
    return {
      match: linked,
      players: current,
      keptExisting: true,
      warning: WC3STATS_REFRESH_KEPT_MESSAGE,
      boundNow,
      message: refreshResultMessage({
        boundNow,
        gameId,
        warning: WC3STATS_REFRESH_KEPT_MESSAGE,
      }),
    };
  }

  const updated = await replaceMatchRoster(linked.id, applied.players);
  await syncLobbyDiscordMessage(input.client, updated, 'pending');
  return {
    match: updated,
    players: matchToLobbyPlayers(updated),
    keptExisting: false,
    boundNow,
    message: refreshResultMessage({ boundNow, gameId: updated.wc3statsGameId }),
  };
}
