import { describe, expect, it } from 'vitest';
import type { Wc3statsListGame } from './wc3stats-client.js';
import {
  pickUdbrLobbiesContainingNick,
  resolveWc3statsLobby,
  wc3statsLobbyContainsNick,
  WC3STATS_AMBIGUOUS,
  WC3STATS_NICK_NOT_IN_LOBBY,
  WC3STATS_NOT_FOUND,
  WC3STATS_NOT_UDBR,
} from './wc3stats-resolve.js';

const mapConfig = {
  pattern: /ultimate.?dragon.?ball.?reborn|udbr/i,
  sha1Allowlist: new Set<string>(),
};

function game(
  partial: Partial<Wc3statsListGame> & Pick<Wc3statsListGame, 'id' | 'map'>,
): Wc3statsListGame {
  return {
    name: 'lobby',
    host: 'Host#1',
    slotsTaken: 2,
    slotsTotal: 12,
    ...partial,
  };
}

describe('resolveWc3statsLobby', () => {
  it('returns not_found when no UDBR games are live', () => {
    const result = resolveWc3statsLobby({
      games: [game({ id: 1, map: 'DotA_v6.w3x' })],
      mapConfig,
    });
    expect(result).toEqual({
      ok: false,
      code: 'not_found',
      message: WC3STATS_NOT_FOUND,
      candidates: [],
    });
  });

  it('returns the sole UDBR lobby', () => {
    const udbr = game({ id: 9, map: 'UltimateDragonBallReborn.w3x' });
    const result = resolveWc3statsLobby({
      games: [game({ id: 1, map: 'DotA.w3x' }), udbr],
      mapConfig,
    });
    expect(result).toEqual({ ok: true, game: udbr });
  });

  it('returns ambiguous when two UDBR lobbies exist and host is not unique', () => {
    const result = resolveWc3statsLobby({
      games: [
        game({ id: 1, map: 'udbr.w3x', host: 'A#1' }),
        game({ id: 2, map: 'UltimateDragonBallReborn.w3x', host: 'B#1' }),
      ],
      mapConfig,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ambiguous');
      expect(result.message).toBe(WC3STATS_AMBIGUOUS);
      expect(result.candidates).toHaveLength(2);
    }
  });

  it('picks the UDBR lobby whose host matches hostNick', () => {
    const wanted = game({ id: 2, map: 'udbr.w3x', host: 'Goku#1234' });
    const result = resolveWc3statsLobby({
      hostNick: 'goku',
      games: [game({ id: 1, map: 'udbr.w3x', host: 'Vegeta#9' }), wanted],
      mapConfig,
    });
    expect(result).toEqual({ ok: true, game: wanted });
  });

  it('stays ambiguous when two UDBR lobbies share the same host', () => {
    const result = resolveWc3statsLobby({
      hostNick: 'goku',
      games: [
        game({ id: 1, map: 'udbr.w3x', host: 'Goku#1' }),
        game({ id: 2, map: 'udbr.w3x', host: 'Goku#1' }),
      ],
      mapConfig,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ambiguous');
    }
  });
});

describe('wc3statsLobbyContainsNick', () => {
  it('matches the Warcraft list host when slots are unpublished', () => {
    expect(
      wc3statsLobbyContainsNick('tiny', {
        listHost: 'Tiny#11318',
        detail: { id: 1, slotsTaken: 10, slots: [] },
      }),
    ).toBe(true);
  });

  it('matches an occupied human nick', () => {
    expect(
      wc3statsLobbyContainsNick('vegeta', {
        listHost: 'Tiny#1',
        detail: {
          id: 1,
          slots: [
            { status: 'occupied', player: { name: 'Goku' } },
            { status: 'occupied', player: { name: 'Vegeta#99' } },
          ],
        },
      }),
    ).toBe(true);
  });

  it('rejects a nick that is neither host nor seated', () => {
    expect(
      wc3statsLobbyContainsNick('piccolo', {
        listHost: 'Tiny#1',
        detail: {
          id: 1,
          slots: [{ status: 'occupied', player: { name: 'Goku' } }],
        },
      }),
    ).toBe(false);
  });
});

describe('pickUdbrLobbiesContainingNick', () => {
  const udbrMap = {
    name: 'UltimateDragonBallReborn.w3x',
    path: 'Maps/Download/UltimateDragonBallReborn.w3x',
    sha1: 'abc',
  };

  it('picks the lobby where the nick is seated when two UDBR games are live', () => {
    const wanted = game({ id: 2, map: 'udbr.w3x', host: 'Tiny#1' });
    const result = pickUdbrLobbiesContainingNick({
      nick: 'goku',
      mapConfig,
      entries: [
        {
          game: game({ id: 1, map: 'udbr.w3x', host: 'Other#1' }),
          detail: {
            id: 1,
            map: udbrMap,
            host: 'Other#1',
            slots: [{ status: 'occupied', player: { name: 'Vegeta' } }],
          },
        },
        {
          game: wanted,
          detail: {
            id: 2,
            map: udbrMap,
            host: 'Tiny#1',
            slots: [
              { status: 'occupied', player: { name: 'Tiny' } },
              { status: 'occupied', player: { name: 'Goku' } },
            ],
          },
        },
      ],
    });
    expect(result).toEqual({ ok: true, game: wanted });
  });

  it('returns not_found when the linked nick is in no live UDBR lobby', () => {
    const result = pickUdbrLobbiesContainingNick({
      nick: 'piccolo',
      mapConfig,
      entries: [
        {
          game: game({ id: 1, map: 'udbr.w3x', host: 'Tiny#1' }),
          detail: {
            id: 1,
            map: udbrMap,
            host: 'Tiny#1',
            slots: [{ status: 'occupied', player: { name: 'Goku' } }],
          },
        },
      ],
    });
    expect(result).toEqual({
      ok: false,
      code: 'not_found',
      message: WC3STATS_NICK_NOT_IN_LOBBY,
      candidates: [],
    });
  });

  it('returns ambiguous when the nick is in two live UDBR lobbies', () => {
    const result = pickUdbrLobbiesContainingNick({
      nick: 'goku',
      mapConfig,
      entries: [
        {
          game: game({ id: 1, map: 'udbr.w3x', host: 'A#1' }),
          detail: {
            id: 1,
            map: udbrMap,
            slots: [{ status: 'occupied', player: { name: 'Goku' } }],
          },
        },
        {
          game: game({ id: 2, map: 'udbr.w3x', host: 'B#1' }),
          detail: {
            id: 2,
            map: udbrMap,
            slots: [{ status: 'occupied', player: { name: 'Goku' } }],
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ambiguous');
      expect(result.candidates).toHaveLength(2);
    }
  });
});

describe('WC3STATS_NOT_UDBR', () => {
  it('uses generic wrong-map copy', () => {
    expect(WC3STATS_NOT_UDBR).toBe('That lobby is not on the configured map for this league.');
  });
});
