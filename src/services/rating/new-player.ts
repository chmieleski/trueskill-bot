import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { compactUuidForCustomId, expandUuidFromCustomId } from '../match/compact-custom-id.js';
import { gamesByPlayerFromStats, loadMatchDisplayStatsByPlayer } from './rank-reset-display.js';
import { KI_Z_BLEND_GAMES } from './rating-math.js';

type Db = Prisma.TransactionClient | typeof prisma;

/** Payload for host/mod New-player confirm prompts after a roster add or PENDING create. */
export type NewPlayerSuggestion = {
  playerId: string;
  username: string;
  leagueId: string;
  matchId: string;
};

/** Roster suffix rendered as ` · New`. */
export const NEW_PLAYER_LABEL = 'New';

/** Appended outside the roster code span when the player is New. */
export const NEW_PLAYER_ROSTER_MARKER = ` · ${NEW_PLAYER_LABEL}`;

/** Prefix for new-player confirmation button custom IDs. */
export const NEW_PLAYER_PROMPT_PREFIX = 'np:';

const NEW_PLAYER_CUSTOM_ID_PREFIX = 'np';
/** Short action codes so Discord customIds stay ≤ 100 chars. */
const NEW_PLAYER_CONFIRM_ACTION = 'c';
const NEW_PLAYER_DECLINE_ACTION = 'd';

export type NewPlayerButtonAction = 'confirm' | 'decline';

export type ParsedNewPlayerButtonCustomId = {
  action: NewPlayerButtonAction;
  matchId: string;
  playerId: string;
  actorDiscordId: string;
};

/** True when a host may be prompted to mark a player as new (0 games, not already flagged). */
export function shouldSuggestNewPlayer(completedGames: number, isAlreadyNew: boolean): boolean {
  return completedGames === 0 && !isAlreadyNew;
}

/** True once the player has completed enough games to leave the calibrating window. */
export function shouldClearNewPlayer(completedGamesAfterMatch: number): boolean {
  return completedGamesAfterMatch >= KI_Z_BLEND_GAMES;
}

/**
 * Player ids whose after-match completed-game count meets the New clear threshold.
 * Missing map entries count as 0 games.
 */
export function playerIdsToClearNewFlag(
  playerIds: string[],
  gamesByPlayer: Map<string, number>,
): string[] {
  return playerIds.filter((id) => shouldClearNewPlayer(gamesByPlayer.get(id) ?? 0));
}

/**
 * Load live `PlayerRating.isNewPlayer` for a roster (missing rows ⇒ false).
 */
export async function loadIsNewPlayerByPlayerId(
  leagueId: string,
  playerIds: string[],
  db: Db = prisma,
): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>(playerIds.map((id) => [id, false]));
  if (playerIds.length === 0) {
    return map;
  }

  const rows = await db.playerRating.findMany({
    where: { leagueId, playerId: { in: playerIds } },
    select: { playerId: true, isNewPlayer: true },
  });

  for (const row of rows) {
    map.set(row.playerId, row.isNewPlayer);
  }
  return map;
}

/**
 * Newly seated players eligible for a New-player suggest (0 completed games, not already New).
 * One entry per playerId; undefined when none qualify.
 */
export async function collectNewPlayerSuggestions(input: {
  leagueId: string;
  matchId: string;
  previousPlayerIds: Set<string>;
  nextPlayers: Array<{ playerId: string; username: string }>;
  db?: Db;
}): Promise<NewPlayerSuggestion[] | undefined> {
  const db = input.db ?? prisma;
  const newcomers: Array<{ playerId: string; username: string }> = [];
  const seen = new Set<string>();

  for (const player of input.nextPlayers) {
    if (input.previousPlayerIds.has(player.playerId) || seen.has(player.playerId)) {
      continue;
    }
    seen.add(player.playerId);
    newcomers.push(player);
  }

  if (newcomers.length === 0) {
    return undefined;
  }

  const playerIds = newcomers.map((player) => player.playerId);
  const [displayStats, isNewByPlayer] = await Promise.all([
    loadMatchDisplayStatsByPlayer(input.leagueId, playerIds, db),
    loadIsNewPlayerByPlayerId(input.leagueId, playerIds, db),
  ]);
  const gamesByPlayer = gamesByPlayerFromStats(displayStats);

  const suggestions: NewPlayerSuggestion[] = [];
  for (const player of newcomers) {
    const games = gamesByPlayer.get(player.playerId) ?? 0;
    const isAlreadyNew = isNewByPlayer.get(player.playerId) ?? false;
    if (!shouldSuggestNewPlayer(games, isAlreadyNew)) {
      continue;
    }
    suggestions.push({
      playerId: player.playerId,
      username: player.username,
      leagueId: input.leagueId,
      matchId: input.matchId,
    });
  }

  return suggestions.length > 0 ? suggestions : undefined;
}

/**
 * After PENDING create with a seated roster, treat every seated player as newly joined
 * (`previousPlayerIds` empty). Returns [] when the roster is empty or nobody qualifies.
 * One follow-up prompt per suggestion is fine for v1 (register/create can seat many).
 */
export async function collectNewPlayerSuggestionsForPendingCreate(input: {
  leagueId: string;
  matchId: string;
  players: Array<{ playerId: string; username: string }>;
  db?: Db;
}): Promise<NewPlayerSuggestion[]> {
  if (input.players.length === 0) {
    return [];
  }

  const suggestions = await collectNewPlayerSuggestions({
    leagueId: input.leagueId,
    matchId: input.matchId,
    previousPlayerIds: new Set(),
    nextPlayers: input.players,
    db: input.db,
  });
  return suggestions ?? [];
}

function newPlayerActionCode(action: NewPlayerButtonAction): string {
  return action === 'confirm' ? NEW_PLAYER_CONFIRM_ACTION : NEW_PLAYER_DECLINE_ACTION;
}

function parseNewPlayerActionCode(actionCode: string): NewPlayerButtonAction | null {
  if (actionCode === NEW_PLAYER_CONFIRM_ACTION) {
    return 'confirm';
  }
  if (actionCode === NEW_PLAYER_DECLINE_ACTION) {
    return 'decline';
  }
  return null;
}

/**
 * Shape: `np:c|d:<matchId>:<compactPlayerId>:<actorDiscordId>`.
 * Omits leagueId (load from match on click) so realistic ids stay ≤ Discord's 100-char limit.
 */
function buildNewPlayerButtonCustomId(
  action: NewPlayerButtonAction,
  matchId: string,
  playerId: string,
  actorDiscordId: string,
): string {
  return [
    NEW_PLAYER_CUSTOM_ID_PREFIX,
    newPlayerActionCode(action),
    matchId,
    compactUuidForCustomId(playerId),
    actorDiscordId,
  ].join(':');
}

/** Bind a confirmation button to its match, player, and initiating actor. */
export function buildNewPlayerConfirmCustomId(
  matchId: string,
  playerId: string,
  actorDiscordId: string,
): string {
  return buildNewPlayerButtonCustomId('confirm', matchId, playerId, actorDiscordId);
}

/** Bind a decline button to its match, player, and initiating actor. */
export function buildNewPlayerDeclineCustomId(
  matchId: string,
  playerId: string,
  actorDiscordId: string,
): string {
  return buildNewPlayerButtonCustomId('decline', matchId, playerId, actorDiscordId);
}

/** Parse a new-player button ID, returning null for malformed or unrelated IDs. */
export function parseNewPlayerButtonCustomId(
  customId: string,
): ParsedNewPlayerButtonCustomId | null {
  const [prefix, actionCode, matchId, compactPlayerId, actorDiscordId, extra] = customId.split(':');
  const action = parseNewPlayerActionCode(actionCode ?? '');
  if (
    prefix !== NEW_PLAYER_CUSTOM_ID_PREFIX ||
    action === null ||
    !matchId ||
    !compactPlayerId ||
    !actorDiscordId ||
    extra !== undefined
  ) {
    return null;
  }
  return {
    action,
    matchId,
    playerId: expandUuidFromCustomId(compactPlayerId),
    actorDiscordId,
  };
}
