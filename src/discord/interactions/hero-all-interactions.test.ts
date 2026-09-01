import { describe, expect, it, vi } from 'vitest';
import { handleHeroAllInteraction } from './hero-all-interactions.js';

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: {
      findUnique: vi.fn().mockResolvedValue({ name: 'WOS IHL' }),
    },
  },
}));

vi.mock('../../services/league/index.js', () => ({
  getGameProfileForLeague: vi.fn().mockResolvedValue({
    gameId: 'warcraft3_wos',
    postMatchStats: 'wos2_bot_v1',
  }),
}));

vi.mock('../../services/player/hero-stats.js', () => ({
  loadAllHeroRankings: vi.fn().mockResolvedValue({
    sort: 'win_rate',
    page: 2,
    totalPages: 2,
    totalHeroes: 20,
    windows: { last20: [], overall: [] },
  }),
}));

function buttonInteraction(customId: string, userId = '123456789012345678') {
  return {
    isButton: () => true,
    customId,
    user: { id: userId },
    reply: vi.fn(),
    deferUpdate: vi.fn(),
    editReply: vi.fn(),
  };
}

describe('handleHeroAllInteraction', () => {
  it('ignores unrelated interactions', async () => {
    const interaction = {
      isButton: () => true,
      customId: 'leaderboard:page:1',
    };
    await expect(handleHeroAllInteraction(interaction as never)).resolves.toBe(false);
  });

  it('rejects pagination from a different user', async () => {
    const interaction = buttonInteraction(
      'ha:p:123456789012345678:e5863052d45348dbb67a14d1175c298b:n:1:wr:b',
      'other-user',
    );
    await expect(handleHeroAllInteraction(interaction as never)).resolves.toBe(true);
    expect(interaction.reply).toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });

  it('updates the embed when the invoker clicks next', async () => {
    const interaction = buttonInteraction(
      'ha:p:123456789012345678:e5863052d45348dbb67a14d1175c298b:n:1:wr:b',
    );
    await expect(handleHeroAllInteraction(interaction as never)).resolves.toBe(true);
    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        components: expect.any(Array),
      }),
    );
  });
});
