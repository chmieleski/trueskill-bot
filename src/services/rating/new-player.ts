import { KI_Z_BLEND_GAMES } from './rating-math.js';

/** Roster suffix rendered as ` · New`. */
export const NEW_PLAYER_LABEL = 'New';

/** Prefix for new-player confirmation button custom IDs. */
export const NEW_PLAYER_PROMPT_PREFIX = 'np:';

const NEW_PLAYER_CUSTOM_ID_PREFIX = 'np';
const NEW_PLAYER_CONFIRM_ACTION = 'confirm';
const NEW_PLAYER_DECLINE_ACTION = 'decline';

export type NewPlayerButtonAction = 'confirm' | 'decline';

export type ParsedNewPlayerButtonCustomId = {
  action: NewPlayerButtonAction;
  matchId: string;
  leagueId: string;
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

function parseNewPlayerActionCode(actionCode: string): NewPlayerButtonAction | null {
  if (actionCode === NEW_PLAYER_CONFIRM_ACTION) {
    return 'confirm';
  }
  if (actionCode === NEW_PLAYER_DECLINE_ACTION) {
    return 'decline';
  }
  return null;
}

function buildNewPlayerButtonCustomId(
  action: NewPlayerButtonAction,
  matchId: string,
  leagueId: string,
  playerId: string,
  actorDiscordId: string,
): string {
  return [
    NEW_PLAYER_CUSTOM_ID_PREFIX,
    action,
    matchId,
    leagueId,
    playerId,
    actorDiscordId,
  ].join(':');
}

/** Bind a confirmation button to its match, league, player, and initiating actor. */
export function buildNewPlayerConfirmCustomId(
  matchId: string,
  leagueId: string,
  playerId: string,
  actorDiscordId: string,
): string {
  return buildNewPlayerButtonCustomId(
    'confirm',
    matchId,
    leagueId,
    playerId,
    actorDiscordId,
  );
}

/** Bind a decline button to its match, league, player, and initiating actor. */
export function buildNewPlayerDeclineCustomId(
  matchId: string,
  leagueId: string,
  playerId: string,
  actorDiscordId: string,
): string {
  return buildNewPlayerButtonCustomId(
    'decline',
    matchId,
    leagueId,
    playerId,
    actorDiscordId,
  );
}

/** Parse a new-player button ID, returning null for malformed or unrelated IDs. */
export function parseNewPlayerButtonCustomId(
  customId: string,
): ParsedNewPlayerButtonCustomId | null {
  const [prefix, actionCode, matchId, leagueId, playerId, actorDiscordId, extra] =
    customId.split(':');
  const action = parseNewPlayerActionCode(actionCode ?? '');
  if (
    prefix !== NEW_PLAYER_CUSTOM_ID_PREFIX ||
    action === null ||
    !matchId ||
    !leagueId ||
    !playerId ||
    !actorDiscordId ||
    extra !== undefined
  ) {
    return null;
  }
  return { action, matchId, leagueId, playerId, actorDiscordId };
}
