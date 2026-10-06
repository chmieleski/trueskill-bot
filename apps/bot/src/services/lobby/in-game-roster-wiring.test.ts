import type { Client } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';

/**
 * Snapshot wiring: game reads (screenshot) must tag the roster write with a
 * source; Discord-side edits (Balance) must not, or the swap diff collapses.
 */

const mocks = vi.hoisted(() => ({
  applyRosterAndSync: vi.fn(),
  resolvePendingMatchForManage: vi.fn(),
  extractLobbyPlayers: vi.fn(),
  loadBalanceContext: vi.fn(),
}));

vi.mock('./discord-sync.js', () => ({
  applyRosterAndSync: mocks.applyRosterAndSync,
  syncLobbyDiscordMessage: vi.fn(),
  withNewPlayerSuggestions: vi.fn(async (result) => result),
}));

vi.mock('./resolve.js', () => ({
  resolvePendingMatchForManage: mocks.resolvePendingMatchForManage,
  resolveHostPendingMatch: vi.fn(),
  resolvePendingMatchByMessageId: vi.fn(),
}));

vi.mock('./lobby-ocr.js', () => ({
  extractLobbyPlayers: mocks.extractLobbyPlayers,
}));

vi.mock('./ocr-nick-aliases.js', () => ({
  applyOcrNickAliases: vi.fn((players) => players),
  loadLeagueOcrNickAliasMap: vi.fn(async () => new Map()),
}));

vi.mock('../match/match-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../match/match-service.js')>()),
  getGameProfileForMatch: vi.fn(async () => getGameProfile(WARCRAFT3_UDBR_GAME_ID)),
  touchLobbyRosterAuthority: vi.fn(),
}));

vi.mock('../rating/rating-preview.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../rating/rating-preview.js')>()),
  loadBalanceContext: mocks.loadBalanceContext,
}));

import { balanceLobbyRoster } from './actions.js';
import { refreshLobbyFromScreenshot } from './lobby-screenshot.js';

const client = {} as Client;
const match = {
  id: 'm1',
  leagueId: 'league-1',
  eventId: null,
  players: [
    { playerId: 'p1', slot: 1, team: 1, heroId: 1, locked: false, player: { username: 'goku' } },
    { playerId: 'p2', slot: 7, team: 2, heroId: 7, locked: false, player: { username: 'broly' } },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolvePendingMatchForManage.mockResolvedValue({
    match,
    players: [
      { slot: 1, nick: 'goku' },
      { slot: 7, nick: 'broly' },
    ],
  });
  mocks.applyRosterAndSync.mockResolvedValue({ match, players: [] });
});

describe('in-game roster snapshot wiring', () => {
  it('screenshot refresh records the roster as a screenshot game read', async () => {
    mocks.extractLobbyPlayers.mockResolvedValue([{ slot: 7, nick: 'goku', rawName: 'Goku' }]);

    await refreshLobbyFromScreenshot({
      client,
      actorDiscordId: 'host',
      memberRoleIds: [],
      attachmentUrl: 'https://cdn.example/lobby.png',
      mimeType: 'image/png',
    });

    expect(mocks.applyRosterAndSync).toHaveBeenCalledWith(
      client,
      'm1',
      [{ slot: 7, nick: 'goku', rawName: 'Goku' }],
      { inGameRosterSource: 'screenshot' },
    );
  });

  it('Balance writes the Discord roster without touching the in-game snapshot', async () => {
    mocks.loadBalanceContext.mockResolvedValue({
      roster: [
        { playerId: 'p1', slot: 1, team: 1, heroId: 1, nick: 'goku' },
        { playerId: 'p2', slot: 7, team: 2, heroId: 7, nick: 'broly' },
      ],
      lookup: {
        global: (id: string) => (id === 'p1' ? { mu: 40, sigma: 2 } : { mu: 20, sigma: 2 }),
        hero: () => ({ mu: 25, sigma: 8.333 }),
      },
      options: {},
    });

    await balanceLobbyRoster({ client, actorDiscordId: 'host', memberRoleIds: [] });

    expect(mocks.applyRosterAndSync).toHaveBeenCalledTimes(1);
    expect(mocks.applyRosterAndSync.mock.calls[0]).toHaveLength(3);
  });
});
