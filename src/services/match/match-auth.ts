import { isUniversalMatchMod } from '../guild/guild-config.js';
import { MatchServiceError } from './match-service.js';

const FORBIDDEN = 'Only the match host or a match moderator can do that.';
const CREATE_DISABLED = 'Match creation is disabled until a create role is configured.';
const CREATE_FORBIDDEN = 'Only members with the match creator role can register a lobby.';
const MOD_NOT_CONFIGURED = 'Match moderator role is not configured.';
const MOD_FORBIDDEN = 'Only match moderators can do that.';

export function canManageMatch(input: {
  hostDiscordId: string;
  actorDiscordId: string;
  memberRoleIds: string[];
  matchModRoleId?: string;
}): boolean {
  if (input.actorDiscordId === input.hostDiscordId) {
    return true;
  }

  if (isUniversalMatchMod(input.actorDiscordId)) {
    return true;
  }

  const modRoleId = input.matchModRoleId;
  if (!modRoleId) {
    return false;
  }

  return input.memberRoleIds.includes(modRoleId);
}

export function assertCanManageMatch(input: {
  hostDiscordId: string;
  actorDiscordId: string;
  memberRoleIds: string[];
  matchModRoleId?: string;
}): void {
  if (!canManageMatch(input)) {
    throw new MatchServiceError(FORBIDDEN);
  }
}

export function canCreateMatch(input: {
  memberRoleIds: string[];
  matchCreateRoleId?: string;
}): boolean {
  const createRoleId = input.matchCreateRoleId;
  if (!createRoleId) {
    return false;
  }

  return input.memberRoleIds.includes(createRoleId);
}

export function assertCanCreateMatch(input: {
  memberRoleIds: string[];
  matchCreateRoleId?: string;
}): void {
  if (canCreateMatch(input)) {
    return;
  }

  if (!input.matchCreateRoleId) {
    throw new MatchServiceError(CREATE_DISABLED);
  }

  throw new MatchServiceError(CREATE_FORBIDDEN);
}

export function hasMatchModRole(input: {
  actorDiscordId: string;
  memberRoleIds: string[];
  matchModRoleId?: string;
}): boolean {
  if (isUniversalMatchMod(input.actorDiscordId)) {
    return true;
  }

  const modRoleId = input.matchModRoleId;
  if (!modRoleId) {
    return false;
  }
  return input.memberRoleIds.includes(modRoleId);
}

export function assertHasMatchModRole(input: {
  actorDiscordId: string;
  memberRoleIds: string[];
  matchModRoleId?: string;
}): void {
  if (isUniversalMatchMod(input.actorDiscordId)) {
    return;
  }
  if (!input.matchModRoleId) {
    throw new MatchServiceError(MOD_NOT_CONFIGURED);
  }
  if (!hasMatchModRole(input)) {
    throw new MatchServiceError(MOD_FORBIDDEN);
  }
}
