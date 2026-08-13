import { MatchServiceError } from './match-service.js';
import { env } from '../config/env.js';

const FORBIDDEN = 'Only the match host or a match moderator can do that.';
const CREATE_DISABLED =
  'Match creation is disabled until MATCH_CREATE_ROLE_ID is configured.';
const CREATE_FORBIDDEN =
  'Only members with the match creator role can register a lobby.';

export function canManageMatch(input: {
  hostDiscordId: string;
  actorDiscordId: string;
  memberRoleIds: string[];
}): boolean {
  if (input.actorDiscordId === input.hostDiscordId) {
    return true;
  }

  const modRoleId = env.matchModRoleId;
  if (!modRoleId) {
    return false;
  }

  return input.memberRoleIds.includes(modRoleId);
}

export function assertCanManageMatch(input: {
  hostDiscordId: string;
  actorDiscordId: string;
  memberRoleIds: string[];
}): void {
  if (!canManageMatch(input)) {
    throw new MatchServiceError(FORBIDDEN);
  }
}

export function canCreateMatch(input: { memberRoleIds: string[] }): boolean {
  const createRoleId = env.matchCreateRoleId;
  if (!createRoleId) {
    return false;
  }

  return input.memberRoleIds.includes(createRoleId);
}

export function assertCanCreateMatch(input: { memberRoleIds: string[] }): void {
  if (canCreateMatch(input)) {
    return;
  }

  if (!env.matchCreateRoleId) {
    throw new MatchServiceError(CREATE_DISABLED);
  }

  throw new MatchServiceError(CREATE_FORBIDDEN);
}
