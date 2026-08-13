import { MatchServiceError } from './match-service.js';
import { env } from '../config/env.js';

const FORBIDDEN = 'Only the match host or a match moderator can do that.';

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
