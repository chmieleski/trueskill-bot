import type { Client } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { listActiveLobbyDrafts, parseLobbyDraftState } from './draft-state.js';

const log = createLogger('lobby_draft_timer');

const timers = new Map<string, NodeJS.Timeout>();

/** Cancel a scheduled timeout for a draft. */
export function clearLobbyDraftTimer(draftId: string): void {
  const existing = timers.get(draftId);
  if (existing) {
    clearTimeout(existing);
    timers.delete(draftId);
  }
}

/** Schedule (or reschedule) the timeout for a draft deadline. */
export function scheduleLobbyDraftTimeout(
  client: Client,
  draftId: string,
  deadlineIso: string | null,
): void {
  clearLobbyDraftTimer(draftId);
  if (!deadlineIso) return;

  const deadlineMs = new Date(deadlineIso).getTime();
  if (Number.isNaN(deadlineMs)) {
    log.warn({ draftId, deadlineIso }, 'Invalid lobby draft deadline');
    return;
  }

  const handle = setTimeout(
    () => {
      timers.delete(draftId);
      void (async () => {
        try {
          const { applyLobbyDraftTimeout } = await import('./draft-actions.js');
          await applyLobbyDraftTimeout({ client, draftId });
        } catch (error) {
          log.warn({ err: error, draftId }, 'Lobby draft timeout handler failed');
        }
      })();
    },
    Math.max(0, deadlineMs - Date.now()),
  );
  timers.set(draftId, handle);
}

/** On bot boot: reload ACTIVE drafts and schedule remaining (or overdue) deadlines. */
export async function rehydrateLobbyDraftTimers(client: Client): Promise<void> {
  const drafts = await listActiveLobbyDrafts();
  log.info({ count: drafts.length }, 'Rehydrating lobby draft timers');
  const { syncLobbyDraftLiveMessage } = await import('./draft-actions.js');

  for (const draft of drafts) {
    try {
      const { deadlineAt } = parseLobbyDraftState(draft);
      if (!deadlineAt) continue;
      scheduleLobbyDraftTimeout(client, draft.id, deadlineAt);
      await syncLobbyDraftLiveMessage(client, draft.id);
    } catch (error) {
      log.warn({ err: error, draftId: draft.id }, 'Failed to rehydrate lobby draft');
    }
  }
}
