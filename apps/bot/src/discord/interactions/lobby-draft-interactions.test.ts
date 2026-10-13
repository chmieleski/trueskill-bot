import { describe, expect, it, vi } from 'vitest';

const { voteCaptains } = vi.hoisted(() => ({ voteCaptains: vi.fn() }));
vi.mock('../../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('./lobby-interactions.js', () => ({ memberRoleIds: () => [] }));
vi.mock('../../services/lobby-draft/index.js', async (orig) => ({
  ...(await orig<typeof import('../../services/lobby-draft/index.js')>()),
  voteCaptains,
}));
vi.mock('../../services/guild/index.js', () => ({
  resolveGuildConfig: async () => ({ matchModRoleId: undefined }),
}));

import { handleLobbyDraftInteraction } from './lobby-draft-interactions.js';
import { LobbyDraftError } from '../../services/lobby-draft/index.js';

function select(customId: string, values: string[]) {
  const interaction = {
    customId,
    values,
    user: { id: 'u1' },
    member: null,
    guildId: 'g',
    client: {},
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    deferred: false,
    replied: false,
    deferUpdate: vi.fn(async () => {
      interaction.deferred = true;
    }),
    reply: vi.fn(),
    followUp: vi.fn(),
    editReply: vi.fn(),
  };
  return interaction;
}

describe('handleLobbyDraftInteraction', () => {
  it('ignores other custom ids', async () => {
    expect(await handleLobbyDraftInteraction(select('lobby:move', []) as never)).toBe(false);
  });

  it('replies ephemerally with draft errors', async () => {
    voteCaptains.mockRejectedValueOnce(new LobbyDraftError("You're not in this draft."));
    const i = select('ldraft:votesel:d1', ['a']);
    expect(await handleLobbyDraftInteraction(i as never)).toBe(true);
    expect(i.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: "You're not in this draft." }),
    );
  });
});
