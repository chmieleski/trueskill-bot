import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';
import { MatchServiceError } from '../match/match-service.js';

const { leagueFindUnique } = vi.hoisted(() => ({
  leagueFindUnique: vi.fn(),
}));

const { nickForDiscordId } = vi.hoisted(() => ({
  nickForDiscordId: vi.fn(),
}));

const { replaceMatchRoster, getMatchByDiscordMessageId } = vi.hoisted(() => ({
  replaceMatchRoster: vi.fn(),
  getMatchByDiscordMessageId: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique: leagueFindUnique },
  },
}));

vi.mock('./lobby-identity.js', () => ({
  nickForDiscordId,
}));

vi.mock('../match/match-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../match/match-service.js')>();
  return {
    ...actual,
    replaceMatchRoster,
    getMatchByDiscordMessageId,
  };
});

import {
  claimLobbySlot,
  rosterAfterClaim,
  rosterAfterLeave,
} from './index.js';

describe('rosterAfterClaim', () => {
  const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);

  it('adds the nick to an empty slot', () => {
    expect(rosterAfterClaim([], 'Goku', 1, udbr)).toEqual([{ slot: 1, nick: 'goku' }]);
  });

  it('rejects an occupied slot with the occupant nick', () => {
    expect(() =>
      rosterAfterClaim([{ slot: 1, nick: 'vegeta' }], 'goku', 1, udbr),
    ).toThrow('Slot 1 is already occupied by "vegeta".');
  });

  it('rejects when the nick is already in the same slot', () => {
    expect(() =>
      rosterAfterClaim([{ slot: 1, nick: 'goku' }], 'goku', 1, udbr),
    ).toThrow('You are already in slot 1.');
  });

  it('rejects when the nick is already in another slot', () => {
    expect(() =>
      rosterAfterClaim([{ slot: 3, nick: 'goku' }], 'goku', 1, udbr),
    ).toThrow('You are already in slot 3. Leave first.');
  });
});

describe('rosterAfterLeave', () => {
  const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);

  it('removes the linked nick', () => {
    expect(
      rosterAfterLeave(
        [
          { slot: 1, nick: 'goku' },
          { slot: 7, nick: 'vegeta' },
        ],
        'Goku',
        udbr,
      ),
    ).toEqual([{ slot: 7, nick: 'vegeta' }]);
  });

  it('rejects when the nick is not in the lobby', () => {
    expect(() => rosterAfterLeave([{ slot: 1, nick: 'vegeta' }], 'goku', udbr)).toThrow(
      'You are not in this lobby.',
    );
  });
});

describe('claimLobbySlot', () => {
  beforeEach(() => {
    leagueFindUnique.mockReset();
    nickForDiscordId.mockReset();
    replaceMatchRoster.mockReset();
    getMatchByDiscordMessageId.mockReset();
  });

  it('throws before roster mutate when player claim is disabled', async () => {
    getMatchByDiscordMessageId.mockResolvedValue({
      id: 'match-1',
      leagueId: 'league-1',
      status: 'PENDING',
      players: [],
    });
    leagueFindUnique.mockResolvedValue({ lobbyPlayerClaimEnabled: false });

    await expect(
      claimLobbySlot({
        client: { channels: { fetch: vi.fn() } } as never,
        messageId: 'msg-1',
        discordId: 'd1',
        guildId: 'guild-1',
        slot: 1,
      }),
    ).rejects.toBeInstanceOf(MatchServiceError);

    await expect(
      claimLobbySlot({
        client: { channels: { fetch: vi.fn() } } as never,
        messageId: 'msg-1',
        discordId: 'd1',
        guildId: 'guild-1',
        slot: 1,
      }),
    ).rejects.toThrow('Player slot claim is disabled on this server.');

    expect(nickForDiscordId).not.toHaveBeenCalled();
    expect(replaceMatchRoster).not.toHaveBeenCalled();
  });
});
