import { createLogger } from '../../lib/logger.js';
import { assertCanManageMatch } from '../match/match-auth.js';
import {
  findPendingMatchesByHost,
  getMatchByDiscordMessageId,
  getMatchById,
  matchToLobbyPlayers,
  MatchServiceError,
  type MatchWithPlayers,
} from '../match/match-service.js';
import type { LobbyPlayer } from './lobby-ocr.js';

const log = createLogger('lobby-resolve');

const NOT_FOUND_MESSAGE = 'This match lobby was not found. Run /register_lobby again.';
const NOT_EDITABLE_MESSAGE = 'This match can no longer be edited.';
const NO_PENDING_MESSAGE = 'You have no pending match lobby. Run /register_lobby first.';
const AMBIGUOUS_PENDING_MESSAGE =
  'You have more than one pending lobby. Pass match_id to choose which one.';
const OWNER_ONLY_MESSAGE = 'Only the user who registered this lobby can do that.';

export interface ResolveHostPendingMatchInput {
  hostDiscordId: string;
  matchId?: string | null;
}

function assertHostOwnsPending(match: MatchWithPlayers, hostDiscordId: string): void {
  if (match.hostDiscordId !== hostDiscordId) {
    throw new MatchServiceError(OWNER_ONLY_MESSAGE);
  }

  if (match.status !== 'PENDING') {
    throw new MatchServiceError(NOT_EDITABLE_MESSAGE);
  }
}

/**
 * Resolve the host's PENDING match: explicit match_id, or the sole PENDING lobby.
 */
export async function resolveHostPendingMatch(
  input: ResolveHostPendingMatchInput,
): Promise<{ match: MatchWithPlayers; players: LobbyPlayer[] }> {
  const { hostDiscordId, matchId } = input;

  if (matchId) {
    const match = await getMatchById(matchId);

    if (!match) {
      throw new MatchServiceError(NOT_FOUND_MESSAGE);
    }

    assertHostOwnsPending(match, hostDiscordId);
    return { match, players: matchToLobbyPlayers(match) };
  }

  const pending = await findPendingMatchesByHost(hostDiscordId);

  if (pending.length === 0) {
    throw new MatchServiceError(NO_PENDING_MESSAGE);
  }

  if (pending.length > 1) {
    throw new MatchServiceError(AMBIGUOUS_PENDING_MESSAGE);
  }

  const match = pending[0]!;
  return { match, players: matchToLobbyPlayers(match) };
}

/**
 * Resolve a PENDING match from the Discord lobby message (button/modal path).
 * Any user may act — no host ownership check.
 */
export async function resolvePendingMatchByMessageId(input: {
  messageId: string;
}): Promise<{ match: MatchWithPlayers; players: LobbyPlayer[] }> {
  const match = await getMatchByDiscordMessageId(input.messageId);

  if (!match) {
    log.verbose({ messageId: input.messageId }, 'Match lobby missing for message');
    throw new MatchServiceError(NOT_FOUND_MESSAGE);
  }

  if (match.status !== 'PENDING') {
    log.warn(
      {
        messageId: input.messageId,
        matchId: match.id,
        status: match.status,
      },
      'Lobby not editable',
    );
    throw new MatchServiceError(NOT_EDITABLE_MESSAGE);
  }

  return { match, players: matchToLobbyPlayers(match) };
}

export async function resolveInProgressMatchByMessageId(input: {
  messageId: string;
  actorDiscordId: string;
  memberRoleIds: string[];
  matchModRoleId?: string;
}): Promise<MatchWithPlayers> {
  const match = await getMatchByDiscordMessageId(input.messageId);

  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }

  if (match.status !== 'IN_PROGRESS') {
    throw new MatchServiceError('This match is not in progress.');
  }

  assertCanManageMatch({
    hostDiscordId: match.hostDiscordId,
    actorDiscordId: input.actorDiscordId,
    memberRoleIds: input.memberRoleIds,
    matchModRoleId: input.matchModRoleId,
  });

  return match;
}

/** @deprecated Prefer resolvePendingMatchByMessageId — host check removed. */
export async function resolveHostPendingMatchByMessageId(input: {
  messageId: string;
  hostDiscordId: string;
}): Promise<{ match: MatchWithPlayers; players: LobbyPlayer[] }> {
  return resolvePendingMatchByMessageId({ messageId: input.messageId });
}
