import type { LobbyDraft, Prisma } from '@dbz/db';
import { prisma } from '../../lib/prisma.js';
import {
  LobbyDraftConflictError,
  LobbyDraftError,
  type LobbyDraftState,
  type LobbyDraftStatus,
} from './draft-types.js';

const PHASES = new Set(['VOTE', 'COIN_CHOICE', 'PICK', 'SIDE', 'HERO']);

/** Converts draft state to the Prisma Json column value. */
export function serializeLobbyDraftState(state: LobbyDraftState): Prisma.InputJsonValue {
  return state as unknown as Prisma.InputJsonValue;
}

/** Shape check only: state is written exclusively by this module. */
export function parseLobbyDraftState(row: LobbyDraft): LobbyDraftState {
  const raw = row.state as Record<string, unknown> | null;
  if (
    !raw ||
    typeof raw !== 'object' ||
    !PHASES.has(raw.phase as string) ||
    !Array.isArray(raw.participants) ||
    !Array.isArray(raw.pool) ||
    !Array.isArray(raw.log)
  ) {
    throw new LobbyDraftError('Invalid lobby draft state in database.');
  }
  return raw as unknown as LobbyDraftState;
}

/** Loads a draft by id; throws LobbyDraftError when it does not exist. */
export async function loadLobbyDraftById(draftId: string): Promise<LobbyDraft> {
  const draft = await prisma.lobbyDraft.findUnique({ where: { id: draftId } });
  if (!draft) {
    throw new LobbyDraftError('Captain draft not found.');
  }
  return draft;
}

/** Returns the ACTIVE draft for a match, or null. */
export function findActiveLobbyDraftForMatch(matchId: string): Promise<LobbyDraft | null> {
  return prisma.lobbyDraft.findFirst({ where: { matchId, status: 'ACTIVE' } });
}

/** Returns every ACTIVE draft (used on startup to resume timers). */
export function listActiveLobbyDrafts(): Promise<LobbyDraft[]> {
  return prisma.lobbyDraft.findMany({ where: { status: 'ACTIVE' } });
}

/**
 * Optimistic save: only writes if the row still has the `updatedAt` we read.
 * Throws LobbyDraftConflictError when another writer saved first.
 */
export async function saveLobbyDraftState(
  draft: LobbyDraft,
  state: LobbyDraftState,
  extra: { liveMessageId?: string } = {},
): Promise<LobbyDraft> {
  const { count } = await prisma.lobbyDraft.updateMany({
    where: { id: draft.id, status: 'ACTIVE', updatedAt: draft.updatedAt },
    data: { state: serializeLobbyDraftState(state), ...extra },
  });
  if (count === 0) {
    throw new LobbyDraftConflictError();
  }
  return loadLobbyDraftById(draft.id);
}

/** Sets the lifecycle status (ACTIVE | COMPLETE | CANCELLED). */
export function setLobbyDraftStatus(
  draftId: string,
  status: LobbyDraftStatus,
): Promise<LobbyDraft> {
  return prisma.lobbyDraft.update({ where: { id: draftId }, data: { status } });
}
