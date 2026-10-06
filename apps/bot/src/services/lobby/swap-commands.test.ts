import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadLeagueWc3statsHeroSlotMap } = vi.hoisted(() => ({
  loadLeagueWc3statsHeroSlotMap: vi.fn(),
}));

vi.mock('../wc3stats/wc3stats-slot-map.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../wc3stats/wc3stats-slot-map.js')>()),
  loadLeagueWc3statsHeroSlotMap,
}));

import { getGameProfile, type GameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';
import type { MatchWithPlayers } from '../match/match-service.js';
import { buildSwapCommandLines, loadLobbySwapCommands } from './swap-commands.js';

const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);

describe('buildSwapCommandLines', () => {
  it('maps bot slots to in-game slots and sorts by in-game slot', () => {
    const lines = buildSwapCommandLines({
      profile: udbr,
      target: [
        { slot: 5, nick: 'goku' },
        { slot: 7, nick: 'broly' },
      ],
      // Chain, not a loop: Goku 7 → 5 (empty), Broly 1 → 7 (Goku's old seat).
      snapshot: [
        { slot: 7, nick: 'goku', rawName: 'Goku' },
        { slot: 1, nick: 'broly', rawName: 'Broly' },
      ],
      leagueSlotMap: null,
    });
    expect(lines).toEqual(['!swap Broly 5', '!swap Goku 6']);
  });

  it('returns no lines when the game has no swap command', () => {
    const noSwap: GameProfile = { ...udbr, lobbySwapCommand: 'none' };
    expect(
      buildSwapCommandLines({
        profile: noSwap,
        target: [{ slot: 1, nick: 'goku' }],
        snapshot: [],
        leagueSlotMap: null,
      }),
    ).toEqual([]);
  });
});

describe('loadLobbySwapCommands', () => {
  const observedAt = new Date('2026-10-06T12:00:00Z');

  function pendingMatch(overrides: Partial<MatchWithPlayers>): MatchWithPlayers {
    return {
      id: 'm1',
      leagueId: 'league-1',
      eventId: null,
      inGameRoster: [
        { slot: 7, nick: 'goku', rawName: 'Goku' },
        { slot: 5, nick: 'broly', rawName: 'Broly' },
      ],
      inGameRosterAt: observedAt,
      inGameRosterSource: 'screenshot',
      players: [
        { slot: 5, locked: false, player: { username: 'goku' } },
        { slot: 7, locked: false, player: { username: 'broly' } },
      ],
      ...overrides,
    } as unknown as MatchWithPlayers;
  }

  beforeEach(() => {
    loadLeagueWc3statsHeroSlotMap.mockReset();
    loadLeagueWc3statsHeroSlotMap.mockResolvedValue(null);
  });

  it('builds lines from the stored snapshot for a league lobby', async () => {
    await expect(loadLobbySwapCommands(pendingMatch({}), udbr)).resolves.toEqual({
      // Two-player trade: one swap seats both.
      lines: ['!swap Goku 6'],
      source: 'screenshot',
      observedAt,
    });
    expect(loadLeagueWc3statsHeroSlotMap).toHaveBeenCalledWith('league-1');
  });

  it('uses the game preset for event lobbies without loading a league map', async () => {
    const result = await loadLobbySwapCommands(
      pendingMatch({ leagueId: null, eventId: 'event-1' }),
      udbr,
    );
    expect(result?.lines).toEqual(['!swap Goku 6']);
    expect(loadLeagueWc3statsHeroSlotMap).not.toHaveBeenCalled();
  });

  it('returns undefined for corrupt or missing snapshots', async () => {
    for (const overrides of [
      { inGameRoster: { slot: 1 } },
      { inGameRoster: null },
      { inGameRosterSource: 'telepathy' },
      { inGameRosterAt: null },
    ] as Partial<MatchWithPlayers>[]) {
      await expect(loadLobbySwapCommands(pendingMatch(overrides), udbr)).resolves.toBeUndefined();
    }
  });
});
