import { EmbedBuilder } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique, channelsFetch, enrichCompletedMatchLogEmbeds } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  channelsFetch: vi.fn(),
  enrichCompletedMatchLogEmbeds: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    guildConfig: {
      findUnique,
    },
  },
}));

vi.mock('../../config/env.js', () => ({
  env: {
    matchCreateRoleId: undefined,
    matchModRoleId: undefined,
  },
}));

vi.mock('../match/match-stats-upload.js', () => ({
  enrichCompletedMatchLogEmbeds: enrichCompletedMatchLogEmbeds,
}));

import { postCompletedMatchLog } from './discord-sync.js';
import type { MatchWithPlayers } from '../match/match-service.js';

function baseMatch(overrides: Partial<MatchWithPlayers> = {}): MatchWithPlayers {
  return {
    id: 'match-1',
    discordChannelId: 'lobby-channel',
    discordMessageId: 'lobby-message',
    status: 'COMPLETED',
    leagueId: 'league-1',
    eventId: null,
    wc3statsGameId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    completedAt: new Date('2026-01-02T00:00:00Z'),
    players: [],
    ...overrides,
  } as MatchWithPlayers;
}

describe('postCompletedMatchLog', () => {
  const send = vi.fn();
  const client = { channels: { fetch: channelsFetch } };

  beforeEach(() => {
    findUnique.mockReset();
    channelsFetch.mockReset();
    send.mockReset();
    enrichCompletedMatchLogEmbeds.mockReset();
    enrichCompletedMatchLogEmbeds.mockImplementation(async (_match, embeds) => embeds);
  });

  it('skips when no log channel is configured', async () => {
    channelsFetch.mockResolvedValue({ guildId: 'guild-1' });
    findUnique.mockResolvedValue({ guildId: 'guild-1' });

    await postCompletedMatchLog(client as never, baseMatch(), {
      embeds: [new EmbedBuilder().setTitle('Done')],
    });

    expect(channelsFetch).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('posts a new message when a log channel is configured', async () => {
    channelsFetch.mockImplementation(async (id: string) => {
      if (id === 'lobby-channel') {
        return { guildId: 'guild-1' };
      }
      return { send };
    });
    findUnique.mockResolvedValue({
      guildId: 'guild-1',
      completedMatchLogChannelId: 'log-channel',
    });

    await postCompletedMatchLog(client as never, baseMatch(), {
      embeds: [new EmbedBuilder().setTitle('Done')],
    });

    expect(enrichCompletedMatchLogEmbeds).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      embeds: expect.arrayContaining([expect.objectContaining({ data: expect.any(Object) })]),
    });
  });

  it('skips when the log channel is the same as the lobby channel', async () => {
    channelsFetch.mockResolvedValue({ guildId: 'guild-1' });
    findUnique.mockResolvedValue({
      guildId: 'guild-1',
      completedMatchLogChannelId: 'lobby-channel',
    });

    await postCompletedMatchLog(client as never, baseMatch(), {
      embeds: [new EmbedBuilder().setTitle('Done')],
    });

    expect(channelsFetch).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('skips stats enrichment when enrichStats is false', async () => {
    channelsFetch.mockImplementation(async (id: string) => {
      if (id === 'lobby-channel') {
        return { guildId: 'guild-1' };
      }
      return { send };
    });
    findUnique.mockResolvedValue({
      guildId: 'guild-1',
      completedMatchLogChannelId: 'log-channel',
    });

    const embed = new EmbedBuilder().setTitle('Cancelled');
    await postCompletedMatchLog(
      client as never,
      baseMatch(),
      { embeds: [embed] },
      { enrichStats: false },
    );

    expect(enrichCompletedMatchLogEmbeds).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ embeds: [embed] });
  });
});
