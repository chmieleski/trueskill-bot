import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listActiveLeaguesForGuild, listLeaguesForGuild } = vi.hoisted(() => ({
  listActiveLeaguesForGuild: vi.fn(),
  listLeaguesForGuild: vi.fn(),
}));

vi.mock('./league.js', () => ({
  listActiveLeaguesForGuild,
  listLeaguesForGuild,
}));

import {
  autocompleteActiveGuildLeagues,
  autocompleteAllGuildLeagues,
} from './league-interaction.js';

const activeLeague = {
  id: 'league-active',
  guildId: 'guild-1',
  gameId: 'warcraft3_udbr',
  name: 'Season 2',
  status: 'ACTIVE' as const,
  archivedAt: null,
  createdAt: new Date('2024-02-01'),
  updatedAt: new Date('2024-02-01'),
};

const archivedLeague = {
  id: 'league-archived',
  guildId: 'guild-1',
  gameId: 'warcraft3_udbr',
  name: 'Season 1',
  status: 'ARCHIVED' as const,
  archivedAt: new Date('2024-06-01'),
  createdAt: new Date('2023-01-01'),
  updatedAt: new Date('2024-06-01'),
};

describe('autocompleteActiveGuildLeagues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns active leagues only without archived prefix', async () => {
    listActiveLeaguesForGuild.mockResolvedValue([activeLeague]);

    const choices = await autocompleteActiveGuildLeagues('guild-1', '');

    expect(choices).toEqual([{ name: 'Season 2', value: 'league-active' }]);
    expect(listActiveLeaguesForGuild).toHaveBeenCalledWith('guild-1');
  });
});

describe('autocompleteAllGuildLeagues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefixes archived leagues for history autocomplete', async () => {
    listLeaguesForGuild.mockResolvedValue([archivedLeague, activeLeague]);

    const choices = await autocompleteAllGuildLeagues('guild-1', '');

    expect(choices).toEqual([
      { name: '(archived) Season 1', value: 'league-archived' },
      { name: 'Season 2', value: 'league-active' },
    ]);
    expect(listLeaguesForGuild).toHaveBeenCalledWith('guild-1');
  });
});
