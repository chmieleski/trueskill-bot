import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const findMany = vi.fn();
const setChannel = vi.fn();
const clearChannel = vi.fn();
const loadTop = vi.fn();
const buildEmbeds = vi.fn();

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    guildConfig: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      findMany: (...a: unknown[]) => findMany(...a),
    },
  },
}));

vi.mock('../guild/guild-config.js', () => ({
  setQuitterLeaderboardChannel: (...a: unknown[]) => setChannel(...a),
  clearQuitterLeaderboardChannel: (...a: unknown[]) => clearChannel(...a),
}));

vi.mock('./leaderboard.js', () => ({
  LIVE_LEADERBOARD_DEFAULT_SIZE: 10,
}));

vi.mock('./quitter-leaderboard.js', () => ({
  loadQuitterLeaderboardTop: (...a: unknown[]) => loadTop(...a),
}));

vi.mock('./quitter-leaderboard-embed.js', () => ({
  buildQuitterLiveLeaderboardEmbeds: (...a: unknown[]) => buildEmbeds(...a),
}));

import { refreshGuildQuitterLeaderboard } from './quitter-leaderboard-channel.js';

describe('refreshGuildQuitterLeaderboard', () => {
  beforeEach(() => {
    findUnique.mockReset();
    loadTop.mockReset();
    buildEmbeds.mockReset();
  });

  it('skips when unbound', async () => {
    findUnique.mockResolvedValue({
      quitterLeaderboardChannelId: null,
      quitterLeaderboardMessageId: null,
    });
    await refreshGuildQuitterLeaderboard({} as never, 'g1');
    expect(loadTop).not.toHaveBeenCalled();
  });

  it('loads top with size and edits message', async () => {
    findUnique.mockResolvedValue({
      quitterLeaderboardChannelId: 'c1',
      quitterLeaderboardMessageId: 'm1',
      quitterLeaderboardSize: 50,
      quitterLeaderboardDisplay: 'both',
      quitterLeaderboardSort: 'count',
    });
    loadTop.mockResolvedValue([]);
    buildEmbeds.mockReturnValue([{ fake: true }]);
    const edit = vi.fn();
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          isDMBased: () => false,
          messages: { edit },
        }),
      },
    };
    await refreshGuildQuitterLeaderboard(client as never, 'g1');
    expect(loadTop).toHaveBeenCalledWith('g1', 50, 'both', 'count');
    expect(edit).toHaveBeenCalledWith('m1', { embeds: [{ fake: true }] });
  });
});
