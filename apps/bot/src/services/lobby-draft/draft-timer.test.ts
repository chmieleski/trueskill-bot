import { afterEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  list: vi.fn(),
  finalize: vi.fn(),
  sync: vi.fn(),
  timeout: vi.fn(),
}));
vi.mock('./draft-state.js', async (orig) => ({
  ...(await orig<typeof import('./draft-state.js')>()),
  listActiveLobbyDrafts: m.list,
}));
vi.mock('./draft-actions.js', () => ({
  finalizeLobbyDraft: m.finalize,
  syncLobbyDraftLiveMessage: m.sync,
  applyLobbyDraftTimeout: m.timeout,
}));

import {
  clearLobbyDraftTimer,
  rehydrateLobbyDraftTimers,
  scheduleLobbyDraftTimeout,
} from './draft-timer.js';

const client = {} as never;

describe('lobby draft timer', () => {
  afterEach(() => {
    vi.useRealTimers();
    clearLobbyDraftTimer('d1');
    vi.clearAllMocks();
  });

  it('rehydrate finalizes ACTIVE drafts that already have a heroResult', async () => {
    m.list.mockResolvedValue([
      {
        id: 'd1',
        state: {
          phase: 'HERO',
          participants: [],
          pool: [],
          log: [],
          deadlineAt: null,
          heroResult: { a: { heroId: 1, how: 'pref' } },
        },
      },
    ]);
    await rehydrateLobbyDraftTimers(client);
    expect(m.finalize).toHaveBeenCalledWith(client, 'd1');
  });

  it('retries 5s later when the timeout handler fails with a non-draft error', async () => {
    vi.useFakeTimers();
    m.timeout.mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined);
    scheduleLobbyDraftTimeout(client, 'd1', new Date(Date.now()).toISOString());
    await vi.advanceTimersByTimeAsync(10);
    expect(m.timeout).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(m.timeout).toHaveBeenCalledTimes(2);
  });
});
