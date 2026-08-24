import type { PermissionsBitField, PermissionsString } from 'discord.js';
import { canConfigureBot } from '../guild/guild-config.js';
import { hasMatchModRole } from '../match/match-auth.js';
import { DocsServiceError } from './docs-errors.js';

export const SYNC_DOCS_FORBIDDEN =
  'Only server managers or match moderators can sync Discord docs.';

export function canSyncDocs(input: {
  userId: string;
  memberPermissions:
    PermissionsBitField | bigint | string | ReadonlyArray<PermissionsString> | null | undefined;
  memberRoleIds: string[];
  matchModRoleId?: string;
}): boolean {
  if (canConfigureBot({ userId: input.userId, memberPermissions: input.memberPermissions })) {
    return true;
  }
  return hasMatchModRole({
    actorDiscordId: input.userId,
    memberRoleIds: input.memberRoleIds,
    matchModRoleId: input.matchModRoleId,
  });
}

export function assertCanSyncDocs(input: Parameters<typeof canSyncDocs>[0]): void {
  if (!canSyncDocs(input)) {
    throw new DocsServiceError(SYNC_DOCS_FORBIDDEN);
  }
}
