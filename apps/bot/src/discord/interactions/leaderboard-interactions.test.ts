import { describe, expect, it, vi } from 'vitest';
import { handleLeaderboardInteraction } from './leaderboard-interactions.js';

vi.mock('../../services/leaderboard/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/leaderboard/index.js')>();
  return {
    ...actual,
    loadOverallLeaderboardPage: vi.fn().mockResolvedValue({
      entries: [],
      page: 2,
      totalPages: 38,
      totalPlayers: 375,
    }),
    loadGrieferLeaderboardPage: vi.fn(),
    loadQuitterLeaderboardPage: vi.fn(),
  };
});

vi.mock('../../services/league/index.js', () => ({
  getGameProfileForLeague: vi.fn().mockResolvedValue({
    ratingLabel: 'ki',
  }),
}));

function buttonInteraction(customId: string, userId = '123456789012345678') {
  return {
    isButton: () => true,
    customId,
    user: { id: userId },
    guildId: 'guild-1',
    reply: vi.fn(),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  };
}

describe('handleLeaderboardInteraction', () => {
  it('ignores unrelated interactions', async () => {
    const interaction = buttonInteraction('lobby:start');
    await expect(handleLeaderboardInteraction(interaction as never)).resolves.toBe(false);
  });

  it('rejects pagination from a different user', async () => {
    const interaction = buttonInteraction(
      'leaderboard:page:123456789012345678:next:1:league-1',
      'other-user',
    );
    await expect(handleLeaderboardInteraction(interaction as never)).resolves.toBe(true);
    expect(interaction.reply).toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });

  it('defers the overall page button before loading so Discord does not time out', async () => {
    const { loadOverallLeaderboardPage } = await import('../../services/leaderboard/index.js');
    const loadOrder: string[] = [];

    vi.mocked(loadOverallLeaderboardPage).mockImplementation(async () => {
      loadOrder.push('load');
      return {
        entries: [],
        page: 2,
        totalPages: 38,
        totalPlayers: 375,
      };
    });

    const interaction = buttonInteraction('leaderboard:page:123456789012345678:next:1:league-1');
    interaction.deferUpdate.mockImplementation(async () => {
      loadOrder.push('defer');
    });

    await expect(handleLeaderboardInteraction(interaction as never)).resolves.toBe(true);

    expect(loadOrder).toEqual(['defer', 'load']);
    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        components: expect.any(Array),
      }),
    );
    expect(interaction.update).not.toHaveBeenCalled();
  });
});
