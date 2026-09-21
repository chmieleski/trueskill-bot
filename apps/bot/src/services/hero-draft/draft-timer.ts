import type { Client } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { listActiveHeroDrafts, parseHeroDraftState } from './draft-state.js';

const log = createLogger('hero_draft_timer');

const timers = new Map<string, NodeJS.Timeout>();

/** Cancel a scheduled timeout for a draft. */
export function clearHeroDraftTimer(draftId: string): void {
  const existing = timers.get(draftId);
  if (existing) {
    clearTimeout(existing);
    timers.delete(draftId);
  }
}

/** Schedule (or reschedule) the action timeout for a draft deadline. */
export function scheduleHeroDraftTimeout(
  client: Client,
  draftId: string,
  deadlineIso: string | null,
): void {
  clearHeroDraftTimer(draftId);
  if (!deadlineIso) {
    return;
  }

  const deadlineMs = new Date(deadlineIso).getTime();
  if (Number.isNaN(deadlineMs)) {
    log.warn({ draftId, deadlineIso }, 'Invalid hero draft deadline');
    return;
  }

  const delay = Math.max(0, deadlineMs - Date.now());
  const handle = setTimeout(() => {
    timers.delete(draftId);
    void (async () => {
      try {
        const { applyTimeoutAction } = await import('./draft-actions.js');
        await applyTimeoutAction({ client, draftId });
      } catch (error) {
        log.warn({ err: error, draftId }, 'Hero draft timeout handler failed');
      }
    })();
  }, delay);

  timers.set(draftId, handle);
}

/** On bot boot: reload ACTIVE drafts and schedule remaining (or overdue) deadlines. */
export async function rehydrateHeroDraftTimers(client: Client): Promise<void> {
  const drafts = await listActiveHeroDrafts();
  log.info({ count: drafts.length }, 'Rehydrating hero draft timers');

  const { syncHeroDraftLiveMessage } = await import('./draft-actions.js');

  for (const draft of drafts) {
    try {
      const state = parseHeroDraftState(draft);
      if (!state.actionDeadlineAt) {
        continue;
      }
      scheduleHeroDraftTimeout(client, draft.id, state.actionDeadlineAt);
      await syncHeroDraftLiveMessage(client, draft.id);
    } catch (error) {
      log.warn({ err: error, draftId: draft.id }, 'Failed to rehydrate hero draft');
    }
  }
}
