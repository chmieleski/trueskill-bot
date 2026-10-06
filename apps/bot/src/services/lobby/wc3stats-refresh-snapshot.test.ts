import type { Client } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** An applied wc3stats Refresh is a game read: it must record the in-game snapshot. */

const mocks = vi.hoisted(() => ({
  getMatchByDiscordMessageId: vi.fn(),
  replaceMatchRoster: vi.fn(),
  importWc3statsLobby: vi.fn(),
}));

vi.mock('../match/match-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../match/match-service.js')>()),
  getMatchByDiscordMessageId: mocks.getMatchByDiscordMessageId,
  replaceMatchRoster: mocks.replaceMatchRoster,
}));

vi.mock('../league/league-wc3stats.js', () => ({
  isLeagueWc3statsImportReady: vi.fn(() => true),
  resolveLeagueConfig: vi.fn(async () => ({ wc3statsMapPattern: 'udbr', wc3statsMapSha1: null })),
}));

vi.mock('../match/match-auth.js', () => ({ assertCanManageMatch: vi.fn() }));

vi.mock('../wc3stats/wc3stats-resolve.js', () => ({
  importWc3statsLobby: mocks.importWc3statsLobby,
}));

vi.mock('../wc3stats/wc3stats-slot-map.js', () => ({
  loadLeagueWc3statsHeroSlotMap: vi.fn(async () => null),
}));

vi.mock('./discord-sync.js', () => ({
  syncLobbyDiscordMessage: vi.fn(),
  withNewPlayerSuggestions: vi.fn(async (result) => result),
}));

vi.mock('./register-lobby-source.js', () => ({
  assertLeagueAllowsWc3statsImport: vi.fn(),
}));

import { refreshLobbyFromWc3stats } from './wc3stats-refresh.js';

const match = {
  id: 'm1',
  status: 'PENDING',
  leagueId: 'league-1',
  eventId: null,
  hostDiscordId: 'host',
  wc3statsGameId: '42',
  lobbyRosterAuthorityAt: null,
  players: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMatchByDiscordMessageId.mockResolvedValue(match);
  mocks.replaceMatchRoster.mockResolvedValue({ ...match, players: [] });
});

describe('refreshLobbyFromWc3stats snapshot', () => {
  it('records an applied wc3stats roster as a wc3stats game read', async () => {
    const players = [{ slot: 1, nick: 'goku', rawName: 'Goku' }];
    mocks.importWc3statsLobby.mockResolvedValue({
      ok: true,
      gameId: '42',
      roster: { usable: true, occupiedCount: 1, players },
      rosterObservedAt: null,
    });

    await refreshLobbyFromWc3stats({
      client: {} as Client,
      actorDiscordId: 'host',
      memberRoleIds: [],
      messageId: 'msg-unique-1',
    });

    expect(mocks.replaceMatchRoster).toHaveBeenCalledWith('m1', players, {
      inGameRosterSource: 'wc3stats',
    });
  });
});
