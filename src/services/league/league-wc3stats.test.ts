import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique, update },
  },
}));

vi.mock('../lobby/register-lobby-source.js', () => ({
  assertLeagueAllowsWc3stats: vi.fn(),
  WC3STATS_CONFIG_UNSUPPORTED_MESSAGE: 'Warcraft lobby import is not available for this game.',
}));

import { resolveLeagueConfig, setLeagueWc3statsHostPrompt } from './league-wc3stats.js';
import { MatchServiceError } from '../match/match-service.js';
import { assertLeagueAllowsWc3stats } from '../lobby/register-lobby-source.js';
import { LOBBY_CHANNEL_HOST_PROMPT_MISMATCH } from './league-lobby-channel.js';

describe('resolveLeagueConfig lobby channel', () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it('defaults lobby channel to off when the league row is missing', async () => {
    findUnique.mockResolvedValue(null);
    const resolved = await resolveLeagueConfig('league-1');
    expect(resolved.lobbyChannelEnabled).toBe(false);
    expect(resolved.lobbyChannelId).toBeUndefined();
  });

  it('trims a stored lobby channel id', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: true,
      lobbyChannelId: '  chan-1  ',
    });
    const resolved = await resolveLeagueConfig('league-1');
    expect(resolved.lobbyChannelEnabled).toBe(true);
    expect(resolved.lobbyChannelId).toBe('chan-1');
  });
});

describe('setLeagueWc3statsHostPrompt vs lobby channel', () => {
  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
    vi.mocked(assertLeagueAllowsWc3stats).mockReset();
    vi.mocked(assertLeagueAllowsWc3stats).mockResolvedValue(undefined);
  });

  it('rejects enabling the host prompt on a different channel when lobby channel is ready', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: true,
      lobbyChannelId: 'lobby-chan',
    });

    await expect(
      setLeagueWc3statsHostPrompt('league-1', { enabled: true, channelId: 'other-chan' }),
    ).rejects.toBeInstanceOf(MatchServiceError);

    await expect(
      setLeagueWc3statsHostPrompt('league-1', { enabled: true, channelId: 'other-chan' }),
    ).rejects.toThrow(LOBBY_CHANNEL_HOST_PROMPT_MISMATCH);

    expect(update).not.toHaveBeenCalled();
  });

  it('allows enabling the host prompt when it matches the ready lobby channel', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: true,
      lobbyChannelId: 'lobby-chan',
    });

    await setLeagueWc3statsHostPrompt('league-1', {
      enabled: true,
      channelId: 'lobby-chan',
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'league-1' },
      data: {
        wc3statsHostPromptEnabled: true,
        wc3statsHostPromptChannelId: 'lobby-chan',
      },
    });
  });

  it('does not check lobby channel when disabling the host prompt', async () => {
    await setLeagueWc3statsHostPrompt('league-1', { enabled: false });
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: 'league-1' },
      data: {
        wc3statsHostPromptEnabled: false,
        wc3statsHostPromptChannelId: null,
      },
    });
  });
});
