import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique, create, findMany, update, findFirstConfig } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  findFirstConfig: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    botRelease: { findUnique, create, findMany, update },
    guildConfig: { findFirst: findFirstConfig },
  },
}));

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  }),
}));

const { readAppVersion, readChangelogMarkdown } = vi.hoisted(() => ({
  readAppVersion: vi.fn(),
  readChangelogMarkdown: vi.fn(),
}));

vi.mock('./changelog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./changelog.js')>();
  return {
    ...actual,
    readAppVersion,
    readChangelogMarkdown,
  };
});

import { ensureDraftForVersion, postPendingStaffCards, syncCurrentReleaseDraft } from './release-draft.js';

const CHANGELOG = `# [1.0.0](https://example.com) (2026-08-18)

### Features

* first public release
`;

describe('ensureDraftForVersion', () => {
  beforeEach(() => {
    findUnique.mockReset();
    create.mockReset();
  });

  it('skips placeholder 0.1.0 without writing', async () => {
    await expect(
      ensureDraftForVersion({ version: '0.1.0', changelogMarkdown: CHANGELOG }),
    ).resolves.toBe('skipped_placeholder');
    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('returns missing_notes when the section is absent', async () => {
    findUnique.mockResolvedValue(null);
    await expect(
      ensureDraftForVersion({ version: '1.0.0', changelogMarkdown: '# Changelog\n' }),
    ).resolves.toBe('missing_notes');
    expect(create).not.toHaveBeenCalled();
  });

  it('returns exists when a row is already present', async () => {
    findUnique.mockResolvedValue({ version: '1.0.0' });
    await expect(
      ensureDraftForVersion({ version: '1.0.0', changelogMarkdown: CHANGELOG }),
    ).resolves.toBe('exists');
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a draft with playerNotes copied from engineering notes', async () => {
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({});
    await expect(
      ensureDraftForVersion({ version: '1.0.0', changelogMarkdown: CHANGELOG }),
    ).resolves.toBe('created');
    expect(create).toHaveBeenCalledWith({
      data: {
        version: '1.0.0',
        engineeringNotes: '### Features\n\n* first public release',
        playerNotes: '### Features\n\n* first public release',
        status: 'draft',
      },
    });
  });
});

const DRAFT_ROW = {
  version: '1.4.0',
  playerNotes: 'Hello players',
  engineeringNotes: '### Features\n\n* lobby hint',
  status: 'draft' as const,
  draftGuildId: 'guild-1',
  draftChannelId: 'channel-1',
  draftMessageId: 'msg-1',
};

function draftChannelConfig() {
  return { guildId: 'guild-1', changelogDraftChannelId: 'channel-1' };
}

function textChannel(overrides: Record<string, unknown> = {}) {
  return {
    isTextBased: () => true,
    isDMBased: () => false,
    send: vi.fn().mockResolvedValue({ id: 'new-msg' }),
    messages: {
      fetch: vi.fn(),
    },
    ...overrides,
  };
}

describe('postPendingStaffCards', () => {
  beforeEach(() => {
    findFirstConfig.mockReset();
    findMany.mockReset();
    update.mockReset();
  });

  it('returns without fetching Discord when no draft channel is set', async () => {
    findFirstConfig.mockResolvedValue(null);
    const fetch = vi.fn();
    await postPendingStaffCards({ channels: { fetch } } as never);
    expect(fetch).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('logs and returns when the channel is not text-based', async () => {
    findFirstConfig.mockResolvedValue(draftChannelConfig());
    const fetch = vi.fn().mockResolvedValue({
      isTextBased: () => false,
      send: vi.fn(),
    });
    await postPendingStaffCards({ channels: { fetch } } as never);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('edits an existing staff message and refreshes draft ids', async () => {
    findFirstConfig.mockResolvedValue(draftChannelConfig());
    findMany.mockResolvedValue([DRAFT_ROW]);
    const edit = vi.fn().mockResolvedValue({});
    const channel = textChannel({
      messages: { fetch: vi.fn().mockResolvedValue({ id: 'msg-1', edit }) },
    });
    const client = { channels: { fetch: vi.fn().mockResolvedValue(channel) } };

    await postPendingStaffCards(client as never);

    expect(channel.messages.fetch).toHaveBeenCalledWith('msg-1');
    expect(edit).toHaveBeenCalledOnce();
    expect(channel.send).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { version: '1.4.0' },
      data: {
        draftGuildId: 'guild-1',
        draftChannelId: 'channel-1',
        draftMessageId: 'msg-1',
      },
    });
  });

  it('sends a new staff card when the stored message cannot be fetched', async () => {
    findFirstConfig.mockResolvedValue(draftChannelConfig());
    findMany.mockResolvedValue([DRAFT_ROW]);
    const channel = textChannel({
      messages: { fetch: vi.fn().mockRejectedValue(new Error('Unknown Message')) },
      send: vi.fn().mockResolvedValue({ id: 'new-msg' }),
    });
    const client = { channels: { fetch: vi.fn().mockResolvedValue(channel) } };

    await postPendingStaffCards(client as never);

    expect(channel.send).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({
      where: { version: '1.4.0' },
      data: {
        draftGuildId: 'guild-1',
        draftChannelId: 'channel-1',
        draftMessageId: 'new-msg',
      },
    });
  });

  it('sends a new staff card when the draft has no message id', async () => {
    findFirstConfig.mockResolvedValue(draftChannelConfig());
    findMany.mockResolvedValue([{ ...DRAFT_ROW, draftMessageId: null }]);
    const channel = textChannel();
    const client = { channels: { fetch: vi.fn().mockResolvedValue(channel) } };

    await postPendingStaffCards(client as never);

    expect(channel.messages.fetch).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({
      where: { version: '1.4.0' },
      data: {
        draftGuildId: 'guild-1',
        draftChannelId: 'channel-1',
        draftMessageId: 'new-msg',
      },
    });
  });
});

describe('syncCurrentReleaseDraft', () => {
  beforeEach(() => {
    readAppVersion.mockReset();
    readChangelogMarkdown.mockReset();
    findUnique.mockReset();
    create.mockReset();
    findFirstConfig.mockReset();
    findMany.mockReset();
    update.mockReset();
    findFirstConfig.mockResolvedValue(null);
  });

  it('returns without posting when version or changelog cannot be read', async () => {
    readAppVersion.mockImplementation(() => {
      throw new Error('package.json is missing version');
    });
    const fetch = vi.fn();
    await syncCurrentReleaseDraft({ channels: { fetch } } as never);
    expect(fetch).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('still posts pending cards when the current version has no changelog notes', async () => {
    readAppVersion.mockReturnValue('1.0.0');
    readChangelogMarkdown.mockReturnValue('# Changelog\n');
    findUnique.mockResolvedValue(null);
    findFirstConfig.mockResolvedValue(draftChannelConfig());
    findMany.mockResolvedValue([]);
    const fetch = vi.fn().mockResolvedValue(textChannel());

    await syncCurrentReleaseDraft({ channels: { fetch } } as never);

    expect(create).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith('channel-1');
    expect(findMany).toHaveBeenCalledWith({ where: { status: 'draft' } });
  });
});

