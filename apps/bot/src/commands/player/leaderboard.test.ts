import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  assertCanConfigureBot,
  getLeagueById,
  getLeagueOption,
  resolveLeagueIdFromInteraction,
  setupLiveLeaderboard,
} = vi.hoisted(() => ({
  assertCanConfigureBot: vi.fn(),
  getLeagueById: vi.fn(),
  getLeagueOption: vi.fn(),
  resolveLeagueIdFromInteraction: vi.fn(),
  setupLiveLeaderboard: vi.fn(),
}));

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('../../services/guild/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/guild/index.js')>();
  return { ...actual, assertCanConfigureBot };
});

vi.mock('../../services/leaderboard/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/leaderboard/index.js')>();
  return { ...actual, setupLiveLeaderboard };
});

vi.mock('../../services/league/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/league/index.js')>();
  return {
    ...actual,
    getLeagueById,
    getLeagueOption,
    resolveLeagueIdFromInteraction,
  };
});

import { LEAGUE_ARCHIVED_MESSAGE } from '../../services/league/league.js';
import { execute } from './leaderboard.js';

function setupInteraction(): ChatInputCommandInteraction {
  return {
    guildId: 'guild-1',
    channelId: 'channel-1',
    user: { id: 'user-1' },
    member: null,
    client: {},
    options: {
      getSubcommand: () => 'setup',
      getString: () => 'league-archived',
    },
    reply: vi.fn(),
  } as unknown as ChatInputCommandInteraction;
}

describe('leaderboard setup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    assertCanConfigureBot.mockReturnValue(undefined);
    getLeagueOption.mockReturnValue('league-archived');
    resolveLeagueIdFromInteraction.mockResolvedValue({
      ok: true,
      leagueId: 'league-archived',
    });
  });

  it('rejects archived leagues', async () => {
    getLeagueById.mockResolvedValue({ id: 'league-archived', status: 'ARCHIVED' });
    const interaction = setupInteraction();

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: LEAGUE_ARCHIVED_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    expect(setupLiveLeaderboard).not.toHaveBeenCalled();
  });
});
