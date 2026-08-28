import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findMany } = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    player: { findMany },
    league: { findMany: vi.fn() },
  },
}));

vi.mock('../../config/env.js', () => ({
  env: { wc3statsTimeoutMs: 4000 },
}));

import {
  loadLinkedPlayersByNick,
  listHostPromptReadyLeagues,
} from './wc3stats-host-prompt-poller.js';
import { prisma } from '../../lib/prisma.js';
import { WARCRAFT3_WOS_GAME_ID, WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';

describe('loadLinkedPlayersByNick', () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it('queries only linked players who opted into host prompt pings for the given game', async () => {
    findMany.mockResolvedValue([
      { username: 'Goku', discordId: 'd-goku' },
      { username: 'Vegeta', discordId: 'd-vegeta' },
    ]);

    const map = await loadLinkedPlayersByNick(WARCRAFT3_UDBR_GAME_ID);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        gameId: WARCRAFT3_UDBR_GAME_ID,
        discordId: { not: null },
        wc3statsHostPromptPingsEnabled: true,
      },
      select: { username: true, discordId: true },
    });
    expect(map.get('goku')).toBe('d-goku');
    expect(map.get('vegeta')).toBe('d-vegeta');
  });
});

describe('listHostPromptReadyLeagues', () => {
  it('includes WOS and UDBR leagues when both use wc3stats import', async () => {
    const leagueFindMany = vi.mocked(prisma.league.findMany);
    leagueFindMany.mockResolvedValue([
      {
        id: 'wos',
        guildId: 'g1',
        gameId: WARCRAFT3_WOS_GAME_ID,
        wc3statsHostPromptChannelId: 'ch-wos',
        wc3statsMapPattern: 'wos',
        wc3statsMapSha1: null,
        wc3statsEnabled: true,
        wc3statsHostPromptEnabled: true,
      },
      {
        id: 'udbr',
        guildId: 'g1',
        gameId: WARCRAFT3_UDBR_GAME_ID,
        wc3statsHostPromptChannelId: 'ch-udbr',
        wc3statsMapPattern: 'udbr',
        wc3statsMapSha1: null,
        wc3statsEnabled: true,
        wc3statsHostPromptEnabled: true,
      },
    ] as never);

    const ready = await listHostPromptReadyLeagues();
    expect(ready.map((league) => league.id).sort()).toEqual(['udbr', 'wos']);
  });

  it('skips leagues with an unknown gameId without failing the tick', async () => {
    const leagueFindMany = vi.mocked(prisma.league.findMany);
    leagueFindMany.mockResolvedValue([
      {
        id: 'bad',
        guildId: 'g1',
        gameId: 'valorant_custom',
        wc3statsHostPromptChannelId: 'ch-bad',
        wc3statsMapPattern: 'x',
        wc3statsMapSha1: null,
        wc3statsEnabled: true,
        wc3statsHostPromptEnabled: true,
      },
      {
        id: 'udbr',
        guildId: 'g1',
        gameId: WARCRAFT3_UDBR_GAME_ID,
        wc3statsHostPromptChannelId: 'ch-udbr',
        wc3statsMapPattern: 'udbr',
        wc3statsMapSha1: null,
        wc3statsEnabled: true,
        wc3statsHostPromptEnabled: true,
      },
    ] as never);

    const ready = await listHostPromptReadyLeagues();
    expect(ready.map((league) => league.id)).toEqual(['udbr']);
    expect(ready[0]?.gameId).toBe(WARCRAFT3_UDBR_GAME_ID);
  });

  it('skips a league when lobby channel is ready and differs from the host prompt channel', async () => {
    const leagueFindMany = vi.mocked(prisma.league.findMany);
    leagueFindMany.mockResolvedValue([
      {
        id: 'mismatch',
        guildId: 'g1',
        gameId: WARCRAFT3_UDBR_GAME_ID,
        wc3statsHostPromptChannelId: 'prompt-chan',
        wc3statsMapPattern: 'udbr',
        wc3statsMapSha1: null,
        wc3statsEnabled: true,
        wc3statsHostPromptEnabled: true,
        lobbyChannelEnabled: true,
        lobbyChannelId: 'lobby-chan',
      },
      {
        id: 'aligned',
        guildId: 'g1',
        gameId: WARCRAFT3_UDBR_GAME_ID,
        wc3statsHostPromptChannelId: 'same-chan',
        wc3statsMapPattern: 'udbr',
        wc3statsMapSha1: null,
        wc3statsEnabled: true,
        wc3statsHostPromptEnabled: true,
        lobbyChannelEnabled: true,
        lobbyChannelId: 'same-chan',
      },
    ] as never);

    const ready = await listHostPromptReadyLeagues();
    expect(ready.map((league) => league.id)).toEqual(['aligned']);
  });
});
