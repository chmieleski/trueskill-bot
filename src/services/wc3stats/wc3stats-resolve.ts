import { env } from '../../config/env.js';
import { createLogger } from '../../lib/logger.js';
import { MatchServiceError } from '../match/match-service.js';
import {
  fetchGameDetail,
  fetchGamelist,
  Wc3statsClientError,
  type Wc3statsGameDetail,
  type Wc3statsListGame,
} from './wc3stats-client.js';
import { compileWc3statsMapConfig, isWc3statsMap, type Wc3statsMapConfig } from './wc3stats-map.js';
import { normalizeNick } from '../player/player-nick.js';
import { extractWc3statsRoster, type Wc3statsRosterResult } from './wc3stats-roster.js';
import type { Wc3statsHeroSlotMap } from './wc3stats-slot-map.js';

const log = createLogger('wc3stats-resolve');

export const WC3STATS_NOT_FOUND =
  'No matching Warcraft lobby found. Pass wc3stats_id or add players manually.';
export const WC3STATS_NICK_NOT_IN_LOBBY =
  'No matching lobby found with your linked nick. Sit in the Warcraft lobby or pass wc3stats_id.';
export const WC3STATS_AMBIGUOUS =
  'Several matching lobbies are live. Pass wc3stats_id to choose one.';
export const WC3STATS_NOT_UDBR = 'That lobby is not on the configured map for this league.';

export type ResolveWc3statsLobbyInput = {
  wc3statsId?: number | null;
  hostNick?: string | null;
  games: Wc3statsListGame[];
  mapConfig: Wc3statsMapConfig;
};

export type ResolveWc3statsLobbyResult =
  | { ok: true; game: Wc3statsListGame }
  | {
      ok: false;
      code: 'not_found' | 'ambiguous' | 'not_udbr';
      message: string;
      candidates: Wc3statsListGame[];
    };

export type ImportWc3statsLobbyResult =
  | { ok: true; gameId: string; roster: Wc3statsRosterResult; rosterObservedAt: Date | null }
  | {
      ok: false;
      code: 'not_found' | 'ambiguous' | 'not_udbr' | 'unavailable';
      message: string;
    };

function hostNickFromListGame(game: Wc3statsListGame): string {
  return normalizeNick(game.host);
}

function hostNickFromDetail(detail: Wc3statsGameDetail): string {
  return normalizeNick(detail.host ?? '');
}

/**
 * True when the linked nick is the Warcraft host or an occupied human in slots 1–12.
 */
export function wc3statsLobbyContainsNick(
  nickRaw: string,
  input: { listHost?: string; detail: Wc3statsGameDetail },
): boolean {
  const nick = normalizeNick(nickRaw);
  if (nick === '') {
    return false;
  }

  if (input.listHost) {
    const listHostNick = normalizeNick(input.listHost);
    if (listHostNick === nick) {
      return true;
    }
  }

  if (hostNickFromDetail(input.detail) === nick) {
    return true;
  }

  return extractWc3statsRoster(input.detail).players.some((player) => player.nick === nick);
}

function isMatchingListOrDetail(
  game: Wc3statsListGame,
  detail: Wc3statsGameDetail,
  mapConfig: Wc3statsMapConfig,
): boolean {
  return (
    isWc3statsMap(mapInputFromDetail(detail), mapConfig) ||
    isWc3statsMap({ map: game.map }, mapConfig)
  );
}

/**
 * Pick live map-matching games whose host or published roster contains `nick`.
 * Fail closed when zero or more than one match.
 */
export function pickUdbrLobbiesContainingNick(input: {
  nick: string;
  entries: Array<{ game: Wc3statsListGame; detail: Wc3statsGameDetail }>;
  mapConfig: Wc3statsMapConfig;
}): ResolveWc3statsLobbyResult {
  const nick = normalizeNick(input.nick);
  if (nick === '') {
    return {
      ok: false,
      code: 'not_found',
      message: WC3STATS_NICK_NOT_IN_LOBBY,
      candidates: [],
    };
  }

  const matching = input.entries.filter(
    (entry) =>
      isMatchingListOrDetail(entry.game, entry.detail, input.mapConfig) &&
      wc3statsLobbyContainsNick(nick, { listHost: entry.game.host, detail: entry.detail }),
  );

  if (matching.length === 0) {
    return {
      ok: false,
      code: 'not_found',
      message: WC3STATS_NICK_NOT_IN_LOBBY,
      candidates: [],
    };
  }

  if (matching.length === 1) {
    return { ok: true, game: matching[0]!.game };
  }

  return {
    ok: false,
    code: 'ambiguous',
    message: WC3STATS_AMBIGUOUS,
    candidates: matching.map((entry) => entry.game),
  };
}

function mapInputFromDetail(detail: Wc3statsGameDetail) {
  const map = detail.map;
  if (!map) {
    return {};
  }
  if (typeof map === 'string') {
    return { map };
  }
  return {
    map: map.name,
    path: map.path,
    normalizedName: map.normalizedName,
    sha1: map.sha1,
  };
}

/**
 * Auto-pick a live map-matching lobby from the gamelist.
 * Explicit `wc3stats_id` skips this and goes straight to fetchGameDetail.
 */
export function resolveWc3statsLobby(input: ResolveWc3statsLobbyInput): ResolveWc3statsLobbyResult {
  const matching = input.games.filter((game) => isWc3statsMap({ map: game.map }, input.mapConfig));

  if (matching.length === 0) {
    return { ok: false, code: 'not_found', message: WC3STATS_NOT_FOUND, candidates: [] };
  }

  if (matching.length === 1) {
    return { ok: true, game: matching[0]! };
  }

  const hostNick = input.hostNick ? normalizeNick(input.hostNick) : '';
  if (hostNick !== '') {
    const byHost = matching.filter((game) => hostNickFromListGame(game) === hostNick);
    if (byHost.length === 1) {
      return { ok: true, game: byHost[0]! };
    }
  }

  return {
    ok: false,
    code: 'ambiguous',
    message: WC3STATS_AMBIGUOUS,
    candidates: matching,
  };
}

function importFromLoadedDetail(
  detail: Wc3statsGameDetail,
  mapConfig: Wc3statsMapConfig,
  slotMap?: Wc3statsHeroSlotMap | null,
): ImportWc3statsLobbyResult {
  const mapInput = mapInputFromDetail(detail);
  if (!isWc3statsMap(mapInput, mapConfig)) {
    log.info(
      { id: detail.id, path: mapInput.path, sha1: mapInput.sha1, map: mapInput.map },
      'Rejected wc3stats lobby map',
    );
    return { ok: false, code: 'not_udbr', message: WC3STATS_NOT_UDBR };
  }

  return {
    ok: true,
    gameId: String(detail.id),
    roster: extractWc3statsRoster(detail, { slotMap }),
    rosterObservedAt: detail.rosterObservedAt ?? null,
  };
}

async function importFromDetail(
  id: number,
  timeoutMs: number,
  mapConfig: Wc3statsMapConfig,
  slotMap?: Wc3statsHeroSlotMap | null,
): Promise<ImportWc3statsLobbyResult> {
  let detail: Wc3statsGameDetail;
  try {
    detail = await fetchGameDetail(id, timeoutMs);
  } catch (error) {
    if (error instanceof Wc3statsClientError && error.message.includes('HTTP 404')) {
      return { ok: false, code: 'not_found', message: WC3STATS_NOT_FOUND };
    }
    throw error;
  }

  return importFromLoadedDetail(detail, mapConfig, slotMap);
}

async function importByLinkedNickInLiveLobby(
  hostNick: string,
  timeoutMs: number,
  mapConfig: Wc3statsMapConfig,
  slotMap?: Wc3statsHeroSlotMap | null,
): Promise<ImportWc3statsLobbyResult> {
  const games = await fetchGamelist(timeoutMs);
  const matching = games.filter((game) => isWc3statsMap({ map: game.map }, mapConfig));

  if (matching.length === 0) {
    return { ok: false, code: 'not_found', message: WC3STATS_NICK_NOT_IN_LOBBY };
  }

  const entries: Array<{ game: Wc3statsListGame; detail: Wc3statsGameDetail }> = [];
  const loaded = await Promise.all(
    matching.map(async (game) => {
      try {
        const detail = await fetchGameDetail(game.id, timeoutMs);
        return { game, detail };
      } catch (error) {
        if (error instanceof Wc3statsClientError && error.message.includes('HTTP 404')) {
          return null;
        }
        throw error;
      }
    }),
  );

  for (const entry of loaded) {
    if (entry) {
      entries.push(entry);
    }
  }

  const resolved = pickUdbrLobbiesContainingNick({
    nick: hostNick,
    entries,
    mapConfig,
  });

  if (!resolved.ok) {
    return { ok: false, code: resolved.code, message: resolved.message };
  }

  const matched = entries.find((entry) => entry.game.id === resolved.game.id);
  if (!matched) {
    return { ok: false, code: 'not_found', message: WC3STATS_NICK_NOT_IN_LOBBY };
  }

  return importFromLoadedDetail(matched.detail, mapConfig, slotMap);
}

/**
 * Resolve + fetch a map-matching lobby for /register_lobby. Client failures are `unavailable`.
 */
export async function importWc3statsLobby(input: {
  wc3statsId?: number | null;
  hostNick?: string | null;
  requireNickInLobby?: boolean;
  slotMap?: Wc3statsHeroSlotMap | null;
  mapPattern: string;
  mapSha1: string[];
}): Promise<ImportWc3statsLobbyResult> {
  const timeoutMs = env.wc3statsTimeoutMs;
  if (!input.mapPattern.trim()) {
    throw new MatchServiceError('Warcraft lobby import is not configured for this server.');
  }

  let mapConfig: ReturnType<typeof compileWc3statsMapConfig>;
  try {
    mapConfig = compileWc3statsMapConfig(input.mapPattern, input.mapSha1);
  } catch {
    throw new MatchServiceError('Map pattern is not a valid regular expression.');
  }

  try {
    if (input.wc3statsId) {
      return await importFromDetail(input.wc3statsId, timeoutMs, mapConfig, input.slotMap);
    }

    if (input.requireNickInLobby) {
      const hostNick = input.hostNick?.trim() ?? '';
      if (hostNick === '') {
        return { ok: false, code: 'not_found', message: WC3STATS_NICK_NOT_IN_LOBBY };
      }
      return await importByLinkedNickInLiveLobby(hostNick, timeoutMs, mapConfig, input.slotMap);
    }

    const games = await fetchGamelist(timeoutMs);
    const resolved = resolveWc3statsLobby({
      hostNick: input.hostNick,
      games,
      mapConfig,
    });

    if (!resolved.ok) {
      return { ok: false, code: resolved.code, message: resolved.message };
    }

    return await importFromDetail(resolved.game.id, timeoutMs, mapConfig, input.slotMap);
  } catch (error) {
    if (error instanceof Wc3statsClientError) {
      log.warn({ err: error }, 'wc3stats import unavailable');
      return {
        ok: false,
        code: 'unavailable',
        message: 'Could not read the Warcraft lobby. Add players or attach a screenshot.',
      };
    }
    throw error;
  }
}
