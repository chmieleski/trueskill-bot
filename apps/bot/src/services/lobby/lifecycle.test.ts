import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  cancelDraft: vi.fn(),
  startMatch: vi.fn(),
  cancelMatch: vi.fn(),
  sync: vi.fn(),
  resolveHost: vi.fn(),
  resolveManage: vi.fn(),
}));
vi.mock('../lobby-draft/index.js', () => ({ cancelActiveLobbyDraftForMatch: m.cancelDraft }));
vi.mock('../match/match-service.js', () => ({
  startMatch: m.startMatch,
  cancelMatch: m.cancelMatch,
  matchToLobbyPlayers: () => [],
}));
vi.mock('./discord-sync.js', () => ({ syncLobbyDiscordMessage: m.sync }));
vi.mock('./resolve.js', () => ({
  resolveHostPendingMatch: m.resolveHost,
  resolvePendingMatchByMessageId: m.resolveHost,
  resolvePendingMatchForManage: m.resolveManage,
}));

import { cancelLobbyMatch, startLobbyMatch, startLobbyMatchByMessageId } from './lifecycle.js';

describe('lifecycle cancels active draft', () => {
  beforeEach(() => vi.clearAllMocks());

  it('on start', async () => {
    m.resolveHost.mockResolvedValue({ match: { id: 'M' } });
    m.startMatch.mockResolvedValue({ id: 'M' });
    await startLobbyMatch({ client: {} as never, hostDiscordId: 'h' });
    expect(m.cancelDraft).toHaveBeenCalledWith({}, 'M', 'the lobby was started.');
  });

  it('on cancel', async () => {
    m.resolveManage.mockResolvedValue({ match: { id: 'M', hostDiscordId: 'h' } });
    m.cancelMatch.mockResolvedValue({ id: 'M' });
    await cancelLobbyMatch({ client: {} as never, actorDiscordId: 'h', memberRoleIds: [] });
    expect(m.cancelDraft).toHaveBeenCalledWith({}, 'M', 'the lobby was cancelled.');
  });

  it('on start by message id', async () => {
    m.resolveHost.mockResolvedValue({ match: { id: 'M' } });
    m.startMatch.mockResolvedValue({ id: 'M' });
    await startLobbyMatchByMessageId({ client: {} as never, messageId: 'x' });
    expect(m.cancelDraft).toHaveBeenCalledWith({}, 'M', 'the lobby was started.');
  });

  it('still syncs when draft cancel fails', async () => {
    m.resolveHost.mockResolvedValue({ match: { id: 'M' } });
    m.startMatch.mockResolvedValue({ id: 'M' });
    m.cancelDraft.mockRejectedValue(new Error('db'));
    await expect(
      startLobbyMatch({ client: {} as never, hostDiscordId: 'h' }),
    ).resolves.toBeDefined();
    expect(m.sync).toHaveBeenCalled();
  });

  it('does not cancel draft when startMatch fails', async () => {
    m.resolveHost.mockResolvedValue({ match: { id: 'M' } });
    m.startMatch.mockRejectedValue(new Error('nope'));
    await expect(startLobbyMatch({ client: {} as never, hostDiscordId: 'h' })).rejects.toThrow();
    expect(m.cancelDraft).not.toHaveBeenCalled();
  });
});
