import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique, findFirst, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique, findFirst, update },
  },
}));

import { MatchServiceError } from '../match/match-service.js';
import {
  LOBBY_CHANNEL_CHANNEL_ONLY_WHILE_DISABLED,
  LOBBY_CHANNEL_ENABLE_NEEDS_CHANNEL,
  LOBBY_CHANNEL_HOST_PROMPT_MISMATCH,
  LOBBY_CHANNEL_SET_NEEDS_OPTION,
  assertLeagueLobbyCreateChannel,
  assertLobbyCreateChannel,
  assertLobbyHostPromptChannelsCompatible,
  clearLeagueLobbyChannel,
  formatLobbyChannelConfigLine,
  getLobbyChannelSlashDenial,
  isGuildLobbyChannel,
  isLeagueLobbyChannelReady,
  isLobbyChannelAllowedCommand,
  lobbyChannelCommandsLimitedMessage,
  lobbyCreationLimitedMessage,
  setLeagueLobbyChannel,
} from './league-lobby-channel.js';

describe('isLeagueLobbyChannelReady', () => {
  it('is false when disabled or id is missing', () => {
    expect(isLeagueLobbyChannelReady({})).toBe(false);
    expect(isLeagueLobbyChannelReady({ lobbyChannelEnabled: true })).toBe(false);
    expect(
      isLeagueLobbyChannelReady({ lobbyChannelEnabled: false, lobbyChannelId: 'c' }),
    ).toBe(false);
    expect(
      isLeagueLobbyChannelReady({ lobbyChannelEnabled: true, lobbyChannelId: '  ' }),
    ).toBe(false);
  });

  it('is true when enabled with a non-empty id', () => {
    expect(
      isLeagueLobbyChannelReady({ lobbyChannelEnabled: true, lobbyChannelId: 'c1' }),
    ).toBe(true);
  });
});

describe('assertLobbyCreateChannel', () => {
  it('allows any channel when not ready', () => {
    expect(() => assertLobbyCreateChannel({}, 'anywhere')).not.toThrow();
  });

  it('allows the matching channel when ready', () => {
    expect(() =>
      assertLobbyCreateChannel(
        { lobbyChannelEnabled: true, lobbyChannelId: 'lobby' },
        'lobby',
      ),
    ).not.toThrow();
  });

  it('rejects a different channel when ready', () => {
    expect(() =>
      assertLobbyCreateChannel(
        { lobbyChannelEnabled: true, lobbyChannelId: 'lobby' },
        'other',
      ),
    ).toThrow(MatchServiceError);
    expect(() =>
      assertLobbyCreateChannel(
        { lobbyChannelEnabled: true, lobbyChannelId: 'lobby' },
        'other',
      ),
    ).toThrow(lobbyCreationLimitedMessage('lobby'));
  });
});

describe('assertLobbyHostPromptChannelsCompatible', () => {
  it('allows when either side is not configured', () => {
    expect(() =>
      assertLobbyHostPromptChannelsCompatible({
        lobbyEnabled: true,
        lobbyChannelId: 'a',
        hostPromptEnabled: false,
        hostPromptChannelId: 'b',
      }),
    ).not.toThrow();
  });

  it('rejects when both are configured and ids differ', () => {
    expect(() =>
      assertLobbyHostPromptChannelsCompatible({
        lobbyEnabled: true,
        lobbyChannelId: 'lobby',
        hostPromptEnabled: true,
        hostPromptChannelId: 'prompt',
      }),
    ).toThrow(LOBBY_CHANNEL_HOST_PROMPT_MISMATCH);
  });

  it('allows when both are configured and ids match', () => {
    expect(() =>
      assertLobbyHostPromptChannelsCompatible({
        lobbyEnabled: true,
        lobbyChannelId: 'same',
        hostPromptEnabled: true,
        hostPromptChannelId: 'same',
      }),
    ).not.toThrow();
  });
});

describe('formatLobbyChannelConfigLine', () => {
  it('shows off when disabled with no id', () => {
    expect(formatLobbyChannelConfigLine(false, undefined)).toBe(
      '**Lobby channel:** `off`',
    );
  });

  it('shows saved id when disabled', () => {
    expect(formatLobbyChannelConfigLine(false, 'c1')).toBe(
      '**Lobby channel:** `off` · saved <#c1>',
    );
  });

  it('shows on with mention when ready', () => {
    expect(formatLobbyChannelConfigLine(true, 'c1')).toBe(
      '**Lobby channel:** `on` · <#c1>',
    );
  });

  it('does not show on when enabled without an id', () => {
    expect(formatLobbyChannelConfigLine(true, undefined)).toBe(
      '**Lobby channel:** `off`',
    );
  });
});

describe('assertLeagueLobbyCreateChannel', () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it('loads the league row and allows when not ready', async () => {
    findUnique.mockResolvedValue({ lobbyChannelEnabled: false, lobbyChannelId: null });
    await expect(assertLeagueLobbyCreateChannel('L1', 'any')).resolves.toBeUndefined();
  });

  it('rejects when ready and the interaction channel differs', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: true,
      lobbyChannelId: 'lobby',
    });
    await expect(assertLeagueLobbyCreateChannel('L1', 'other')).rejects.toThrow(
      lobbyCreationLimitedMessage('lobby'),
    );
  });
});

describe('setLeagueLobbyChannel', () => {
  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
  });

  it('rejects when neither enabled nor channel is provided', async () => {
    await expect(setLeagueLobbyChannel('L1', {})).rejects.toThrow(
      LOBBY_CHANNEL_SET_NEEDS_OPTION,
    );
  });

  it('rejects enable true when no channel is passed or stored', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: false,
      lobbyChannelId: null,
      wc3statsHostPromptEnabled: false,
      wc3statsHostPromptChannelId: null,
    });
    await expect(setLeagueLobbyChannel('L1', { enabled: true })).rejects.toThrow(
      LOBBY_CHANNEL_ENABLE_NEEDS_CHANNEL,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('enables and stores the channel', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: false,
      lobbyChannelId: null,
      wc3statsHostPromptEnabled: false,
      wc3statsHostPromptChannelId: null,
    });
    await setLeagueLobbyChannel('L1', { enabled: true, channelId: 'lobby' });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'L1' },
      data: { lobbyChannelEnabled: true, lobbyChannelId: 'lobby' },
    });
  });

  it('re-enables using the stored channel', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: false,
      lobbyChannelId: 'saved',
      wc3statsHostPromptEnabled: false,
      wc3statsHostPromptChannelId: null,
    });
    await setLeagueLobbyChannel('L1', { enabled: true });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'L1' },
      data: { lobbyChannelEnabled: true, lobbyChannelId: 'saved' },
    });
  });

  it('disables and keeps the stored channel', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: true,
      lobbyChannelId: 'saved',
      wc3statsHostPromptEnabled: false,
      wc3statsHostPromptChannelId: null,
    });
    await setLeagueLobbyChannel('L1', { enabled: false, channelId: 'ignored' });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'L1' },
      data: { lobbyChannelEnabled: false },
    });
  });

  it('rejects channel-only while disabled', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: false,
      lobbyChannelId: 'saved',
      wc3statsHostPromptEnabled: false,
      wc3statsHostPromptChannelId: null,
    });
    await expect(setLeagueLobbyChannel('L1', { channelId: 'new' })).rejects.toThrow(
      LOBBY_CHANNEL_CHANNEL_ONLY_WHILE_DISABLED,
    );
  });

  it('updates the channel when already enabled', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: true,
      lobbyChannelId: 'old',
      wc3statsHostPromptEnabled: false,
      wc3statsHostPromptChannelId: null,
    });
    await setLeagueLobbyChannel('L1', { channelId: 'new' });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'L1' },
      data: { lobbyChannelId: 'new' },
    });
  });

  it('rejects enabling on a different channel than a configured host prompt', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: false,
      lobbyChannelId: null,
      wc3statsHostPromptEnabled: true,
      wc3statsHostPromptChannelId: 'prompt',
    });
    await expect(
      setLeagueLobbyChannel('L1', { enabled: true, channelId: 'lobby' }),
    ).rejects.toThrow(LOBBY_CHANNEL_HOST_PROMPT_MISMATCH);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('clearLeagueLobbyChannel', () => {
  beforeEach(() => {
    update.mockReset();
  });

  it('disables and nulls the channel', async () => {
    await clearLeagueLobbyChannel('L1');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'L1' },
      data: { lobbyChannelEnabled: false, lobbyChannelId: null },
    });
  });
});

describe('isLobbyChannelAllowedCommand', () => {
  it('allows register_lobby and lobby regardless of subcommand', () => {
    expect(isLobbyChannelAllowedCommand('register_lobby')).toBe(true);
    expect(isLobbyChannelAllowedCommand('lobby', 'add')).toBe(true);
    expect(isLobbyChannelAllowedCommand('lobby', null)).toBe(true);
  });

  it('allows only match complete, cancel, and quitters', () => {
    expect(isLobbyChannelAllowedCommand('match', 'complete')).toBe(true);
    expect(isLobbyChannelAllowedCommand('match', 'cancel')).toBe(true);
    expect(isLobbyChannelAllowedCommand('match', 'quitters')).toBe(true);
    expect(isLobbyChannelAllowedCommand('match', 'history')).toBe(false);
    expect(isLobbyChannelAllowedCommand('match', 'list')).toBe(false);
    expect(isLobbyChannelAllowedCommand('match', 'show')).toBe(false);
    expect(isLobbyChannelAllowedCommand('match', 'flip')).toBe(false);
    expect(isLobbyChannelAllowedCommand('match', 'void')).toBe(false);
    expect(isLobbyChannelAllowedCommand('match', null)).toBe(false);
    expect(isLobbyChannelAllowedCommand('match')).toBe(false);
  });

  it('blocks other root commands', () => {
    expect(isLobbyChannelAllowedCommand('rank')).toBe(false);
    expect(isLobbyChannelAllowedCommand('config', 'view')).toBe(false);
    expect(isLobbyChannelAllowedCommand('leaderboard', 'show')).toBe(false);
  });
});

describe('lobbyChannelCommandsLimitedMessage', () => {
  it('uses the locked English copy', () => {
    expect(lobbyChannelCommandsLimitedMessage('chan-1')).toBe(
      'Only lobby and match commands can be used in <#chan-1>.',
    );
  });
});

describe('isGuildLobbyChannel', () => {
  beforeEach(() => {
    findFirst.mockReset();
  });

  it('is true when a ready league row matches guild + channel', async () => {
    findFirst.mockResolvedValue({ id: 'L1' });
    await expect(isGuildLobbyChannel('g1', 'lobby')).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        guildId: 'g1',
        lobbyChannelEnabled: true,
        lobbyChannelId: 'lobby',
      },
      select: { id: true },
    });
  });

  it('is false when no row matches', async () => {
    findFirst.mockResolvedValue(null);
    await expect(isGuildLobbyChannel('g1', 'other')).resolves.toBe(false);
  });
});

describe('getLobbyChannelSlashDenial', () => {
  beforeEach(() => {
    findFirst.mockReset();
  });

  it('returns null without guild or channel', async () => {
    await expect(
      getLobbyChannelSlashDenial(null, 'c', 'rank'),
    ).resolves.toBeNull();
    await expect(
      getLobbyChannelSlashDenial('g', null, 'rank'),
    ).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('returns null for allowed commands without hitting the DB', async () => {
    await expect(
      getLobbyChannelSlashDenial('g', 'lobby', 'lobby', 'add'),
    ).resolves.toBeNull();
    await expect(
      getLobbyChannelSlashDenial('g', 'lobby', 'match', 'complete'),
    ).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('returns null when the channel is not a ready lobby channel', async () => {
    findFirst.mockResolvedValue(null);
    await expect(
      getLobbyChannelSlashDenial('g', 'chat', 'rank'),
    ).resolves.toBeNull();
  });

  it('returns the locked message when blocked in a ready lobby channel', async () => {
    findFirst.mockResolvedValue({ id: 'L1' });
    await expect(
      getLobbyChannelSlashDenial('g', 'lobby', 'match', 'history'),
    ).resolves.toBe(lobbyChannelCommandsLimitedMessage('lobby'));
    await expect(
      getLobbyChannelSlashDenial('g', 'lobby', 'rank'),
    ).resolves.toBe(lobbyChannelCommandsLimitedMessage('lobby'));
  });
});
