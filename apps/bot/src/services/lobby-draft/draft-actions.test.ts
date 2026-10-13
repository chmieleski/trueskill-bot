import type { LobbyDraft } from '@dbz/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';

const m = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  replaceMatchRoster: vi.fn(),
  syncLobby: vi.fn(),
  schedule: vi.fn(),
  clear: vi.fn(),
  updateMany: vi.fn(),
}));
vi.mock('./draft-state.js', async (orig) => ({
  ...(await orig<typeof import('./draft-state.js')>()),
  loadLobbyDraftById: m.load,
  saveLobbyDraftState: m.save,
}));
vi.mock('./draft-timer.js', () => ({
  scheduleLobbyDraftTimeout: m.schedule,
  clearLobbyDraftTimer: m.clear,
}));
vi.mock('../league/league-profile.js', () => ({
  getGameProfileForLeague: async () => getGameProfile(WARCRAFT3_UDBR_GAME_ID),
}));
vi.mock('../match/match-service.js', async (orig) => ({
  ...(await orig<typeof import('../match/match-service.js')>()),
  replaceMatchRoster: m.replaceMatchRoster,
}));
vi.mock('../lobby/discord-sync.js', () => ({ syncLobbyDiscordMessage: m.syncLobby }));
vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    hero: { findMany: vi.fn().mockResolvedValue([]) },
    lobbyDraft: { updateMany: m.updateMany },
  },
}));

import { cancelLobbyDraft, lockInHeroes, voteCaptains } from './draft-actions.js';
import { LobbyDraftConflictError } from './draft-types.js';
import { initialLobbyDraftState } from './draft-types.js';
import { person, pickingState } from './test-fixtures.js';

const client = { channels: { fetch: vi.fn().mockResolvedValue(null) } } as never;
function row(state: unknown): LobbyDraft {
  return {
    id: 'd1',
    status: 'ACTIVE',
    leagueId: 'L',
    matchId: 'M',
    threadId: 'T',
    liveMessageId: null,
    hostDiscordId: 'h',
    state,
    updatedAt: new Date(),
  } as unknown as LobbyDraft;
}

describe('lobby draft actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retries on save conflict', async () => {
    const draft = row(
      initialLobbyDraftState(
        ['A', 'B', 'C', 'D'].map((n) => person(n)),
        null,
      ),
    );
    m.load.mockResolvedValue(draft);
    m.save.mockRejectedValueOnce(new LobbyDraftConflictError()).mockResolvedValueOnce(draft);
    await voteCaptains({ client, draftId: 'd1', actorDiscordId: 'id-A', keys: ['a'] });
    expect(m.save).toHaveBeenCalledTimes(2);
  });

  it('finalizes into the lobby when the last linked player locks in', async () => {
    const base = pickingState(['A', 'B', 'C', 'D']);
    const state = {
      ...base,
      phase: 'HERO' as const,
      pool: [],
      teams: [
        { captainKey: 'a', roster: ['a', 'c'], side: 1 as const },
        { captainKey: 'b', roster: ['b', 'd'], side: 2 as const },
      ] as typeof base.teams,
      heroLockedIn: ['a', 'b', 'c'],
    };
    const draft = row(state);
    m.load.mockResolvedValue(draft);
    m.save.mockResolvedValue(draft);
    m.replaceMatchRoster.mockResolvedValue({ id: 'M' });
    await lockInHeroes({ client, draftId: 'd1', actorDiscordId: 'id-D' });
    const [matchId, players, options] = m.replaceMatchRoster.mock.calls[0]!;
    expect(matchId).toBe('M');
    expect(options).toEqual({ markLobbyRosterAuthority: true, completeLobbyDraftId: 'd1' });
    expect(players).toHaveLength(4);
    for (const p of players as Array<{ slot: number; nick: string }>) {
      expect(['A', 'C'].includes(p.nick) ? p.slot <= 6 : p.slot >= 7).toBe(true);
    }
    expect(m.syncLobby).toHaveBeenCalled();
  });

  it('cancelling a non-ACTIVE draft posts nothing', async () => {
    m.updateMany.mockResolvedValue({ count: 0 });
    const send = vi.fn();
    const fetch = vi.fn().mockResolvedValue({ isThread: () => true, send });
    await cancelLobbyDraft({ channels: { fetch } } as never, 'd1', 'x');
    expect(send).not.toHaveBeenCalled();
    expect(m.clear).not.toHaveBeenCalled();
  });
});
