import { createLogger } from '../lib/logger.js';
import type { LobbyPlayer } from './lobby-ocr.js';

const log = createLogger('lobby-draft');

export interface LobbyDraft {
  ownerId: string;
  players: LobbyPlayer[];
  createdAt: number;
  revision: number;
}

const TTL_MS = 30 * 60 * 1000;

const drafts = new Map<string, LobbyDraft>();

function isExpired(draft: LobbyDraft, now = Date.now()): boolean {
  return now - draft.createdAt > TTL_MS;
}

function purgeExpired(now = Date.now()): void {
  let purged = 0;

  for (const [messageId, draft] of drafts) {
    if (isExpired(draft, now)) {
      drafts.delete(messageId);
      purged += 1;
    }
  }

  if (purged > 0) {
    log.debug({ purged, remaining: drafts.size }, 'Purged expired lobby drafts');
  }
}

export function setLobbyDraft(
  messageId: string,
  data: { ownerId: string; players: LobbyPlayer[] },
): LobbyDraft {
  purgeExpired();

  const draft: LobbyDraft = {
    ownerId: data.ownerId,
    players: data.players.map((player) => ({ ...player })),
    createdAt: Date.now(),
    revision: 0,
  };

  drafts.set(messageId, draft);
  log.info(
    { messageId, ownerId: data.ownerId, playerCount: data.players.length, draftCount: drafts.size },
    'Lobby draft stored',
  );
  return draft;
}

export function getLobbyDraft(messageId: string): LobbyDraft | undefined {
  purgeExpired();

  const draft = drafts.get(messageId);

  if (!draft) {
    log.verbose({ messageId }, 'Lobby draft not found');
    return undefined;
  }

  if (isExpired(draft)) {
    drafts.delete(messageId);
    log.debug({ messageId }, 'Lobby draft expired on read');
    return undefined;
  }

  log.verbose({ messageId, revision: draft.revision, playerCount: draft.players.length }, 'Lobby draft hit');
  return draft;
}

export function updateLobbyDraftPlayers(
  messageId: string,
  players: LobbyPlayer[],
): LobbyDraft | undefined {
  const draft = getLobbyDraft(messageId);

  if (!draft) {
    return undefined;
  }

  draft.players = players.map((player) => ({ ...player }));
  draft.revision += 1;
  drafts.set(messageId, draft);
  log.info(
    { messageId, revision: draft.revision, playerCount: players.length },
    'Lobby draft players updated',
  );
  return draft;
}

export function deleteLobbyDraft(messageId: string): void {
  const existed = drafts.delete(messageId);
  log.info({ messageId, existed }, 'Lobby draft deleted');
}
