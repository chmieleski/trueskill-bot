import type { Interaction } from 'discord.js';
import { MessageFlags, TextInputStyle } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  assertCanConfigureBot,
  savePlayerNotes,
  assertCanPublish,
  recordReleasePost,
  markReleasePublished,
  dismissRelease,
  listPlayerChangelogChannels,
  findUniqueRelease,
  findUniquePost,
} = vi.hoisted(() => ({
  assertCanConfigureBot: vi.fn(),
  savePlayerNotes: vi.fn(),
  assertCanPublish: vi.fn(),
  recordReleasePost: vi.fn(),
  markReleasePublished: vi.fn(),
  dismissRelease: vi.fn(),
  listPlayerChangelogChannels: vi.fn(),
  findUniqueRelease: vi.fn(),
  findUniquePost: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    botRelease: { findUnique: findUniqueRelease },
    botReleasePost: { findUnique: findUniquePost },
  },
}));

vi.mock('../../services/guild/index.js', () => ({
  assertCanConfigureBot,
}));

vi.mock('../../services/release/release-publish.js', () => ({
  savePlayerNotes,
  assertCanPublish,
  recordReleasePost,
  markReleasePublished,
  dismissRelease,
  EMPTY_PLAYER_NOTES:
    'Write player notes before publishing. Use Dismiss if this version should not be announced.',
}));

vi.mock('../../services/release/release-config.js', () => ({
  listPlayerChangelogChannels,
}));

import { MatchServiceError } from '../../services/match/index.js';
import { ReleaseServiceError } from '../../services/release/errors.js';
import { EMPTY_PLAYER_NOTES } from '../../services/release/release-publish.js';
import { handleReleaseInteraction } from './release-interactions.js';

const DRAFT = {
  version: '1.4.0',
  playerNotes: 'Hello players',
  engineeringNotes: '### Features\n\n* lobby hint',
  status: 'draft' as const,
};

function releaseInteraction(
  customId: string,
  overrides: Record<string, unknown> = {},
): Interaction {
  const isModal = customId.startsWith('changelog:modal:');
  return {
    isButton: () => !isModal,
    isModalSubmit: () => isModal,
    isFromMessage: () => isModal,
    customId,
    user: { id: 'staff-1' },
    guildId: 'guild-1',
    memberPermissions: { bitfield: 0n },
    client: { channels: { fetch: vi.fn() } },
    reply: vi.fn(),
    showModal: vi.fn(),
    update: vi.fn(),
    deferUpdate: vi.fn(),
    editReply: vi.fn(),
    fields: { getTextInputValue: vi.fn() },
    ...overrides,
  } as unknown as Interaction;
}

describe('handleReleaseInteraction', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    assertCanConfigureBot.mockImplementation(() => undefined);
    findUniqueRelease.mockResolvedValue(DRAFT);
    savePlayerNotes.mockResolvedValue(undefined);
    assertCanPublish.mockImplementation(() => undefined);
    recordReleasePost.mockResolvedValue('inserted');
    markReleasePublished.mockResolvedValue(undefined);
    dismissRelease.mockResolvedValue(undefined);
    listPlayerChangelogChannels.mockResolvedValue([]);
    findUniquePost.mockResolvedValue(null);
  });

  it('returns false when the custom id is not a changelog interaction', async () => {
    const interaction = releaseInteraction('leaderboard:page:1');
    await expect(handleReleaseInteraction(interaction)).resolves.toBe(false);
    expect(assertCanConfigureBot).not.toHaveBeenCalled();
  });

  it('returns false for non-button non-modal interactions', async () => {
    const interaction = {
      isButton: () => false,
      isModalSubmit: () => false,
    } as unknown as Interaction;
    await expect(handleReleaseInteraction(interaction)).resolves.toBe(false);
  });

  it('refuses when used outside a server', async () => {
    const interaction = releaseInteraction('changelog:edit:1.4.0', { guildId: null });
    await expect(handleReleaseInteraction(interaction)).resolves.toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'This action can only be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
    expect(assertCanConfigureBot).not.toHaveBeenCalled();
  });

  it('refuses Edit/Publish/Dismiss without configure permission', async () => {
    assertCanConfigureBot.mockImplementation(() => {
      throw new MatchServiceError('You do not have permission to configure this bot.');
    });
    const interaction = releaseInteraction('changelog:publish:1.4.0');

    await expect(handleReleaseInteraction(interaction)).resolves.toBe(true);
    expect(assertCanConfigureBot).toHaveBeenCalledWith({
      userId: 'staff-1',
      memberPermissions: interaction.memberPermissions,
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'You do not have permission to configure this bot.',
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });

  it('opens an edit modal with player_notes capped at 4000', async () => {
    const longNotes = 'n'.repeat(4010);
    findUniqueRelease.mockResolvedValue({ ...DRAFT, playerNotes: longNotes });
    const interaction = releaseInteraction('changelog:edit:1.4.0');

    await expect(handleReleaseInteraction(interaction)).resolves.toBe(true);
    expect(interaction.showModal).toHaveBeenCalledOnce();

    const modal = (interaction.showModal as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      data: { custom_id?: string };
      toJSON: () => {
        custom_id: string;
        components: Array<{
          components: Array<{
            custom_id: string;
            style: number;
            max_length?: number;
            value?: string;
          }>;
        }>;
      };
    };
    const json = modal.toJSON();
    expect(json.custom_id).toBe('changelog:modal:1.4.0');
    const input = json.components[0]!.components[0]!;
    expect(input.custom_id).toBe('player_notes');
    expect(input.style).toBe(TextInputStyle.Paragraph);
    expect(input.max_length).toBe(4000);
    expect(input.value).toBe('n'.repeat(4000));
  });

  it('saves modal notes and updates the staff embed', async () => {
    findUniqueRelease
      .mockResolvedValueOnce(DRAFT)
      .mockResolvedValueOnce({ ...DRAFT, playerNotes: 'Rewritten notes' });
    const interaction = releaseInteraction('changelog:modal:1.4.0', {
      fields: { getTextInputValue: vi.fn().mockReturnValue('Rewritten notes') },
    });

    await expect(handleReleaseInteraction(interaction)).resolves.toBe(true);
    expect(savePlayerNotes).toHaveBeenCalledWith('1.4.0', 'Rewritten notes');
    expect(interaction.update).toHaveBeenCalledOnce();
    const payload = (interaction.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      embeds: Array<{ data: { title?: string; fields?: Array<{ value: string }> } }>;
      components: unknown[];
    };
    expect(payload.embeds[0]?.data.title).toBe('Draft · v1.4.0');
    expect(payload.embeds[0]?.data.fields?.[0]?.value).toBe('Rewritten notes');
    expect(payload.components).toHaveLength(1);
  });

  it('refuses Publish when player notes are empty', async () => {
    assertCanPublish.mockImplementation(() => {
      throw new ReleaseServiceError(EMPTY_PLAYER_NOTES);
    });
    const interaction = releaseInteraction('changelog:publish:1.4.0');

    await expect(handleReleaseInteraction(interaction)).resolves.toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: EMPTY_PLAYER_NOTES,
      flags: MessageFlags.Ephemeral,
    });
    expect(markReleasePublished).not.toHaveBeenCalled();
  });

  it('skips guilds that already have a post, records new posts, and lists failures', async () => {
    listPlayerChangelogChannels.mockResolvedValue([
      { guildId: 'g-exists', channelId: 'ch-exists' },
      { guildId: 'g-ok', channelId: 'ch-ok' },
      { guildId: 'g-fail', channelId: 'ch-fail' },
    ]);
    findUniquePost.mockImplementation(({ where }: { where: { version_guildId: { guildId: string } } }) =>
      Promise.resolve(where.version_guildId.guildId === 'g-exists' ? { version: '1.4.0' } : null),
    );
    const sendOk = vi.fn().mockResolvedValue({ id: 'posted-1' });
    const fetch = vi.fn().mockImplementation(async (channelId: string) => {
      if (channelId === 'ch-ok') {
        return {
          isTextBased: () => true,
          isDMBased: () => false,
          send: sendOk,
        };
      }
      if (channelId === 'ch-fail') {
        const error = Object.assign(new Error('Missing Access'), { code: 50001 });
        throw error;
      }
      throw new Error(`unexpected channel ${channelId}`);
    });
    recordReleasePost.mockResolvedValue('inserted');
    const interaction = releaseInteraction('changelog:publish:1.4.0', {
      client: { channels: { fetch } },
    });

    await expect(handleReleaseInteraction(interaction)).resolves.toBe(true);

    expect(sendOk).toHaveBeenCalledOnce();
    expect(recordReleasePost).toHaveBeenCalledWith({
      version: '1.4.0',
      guildId: 'g-ok',
      channelId: 'ch-ok',
      messageId: 'posted-1',
    });
    expect(recordReleasePost).not.toHaveBeenCalledWith(
      expect.objectContaining({ guildId: 'g-exists' }),
    );
    expect(markReleasePublished).toHaveBeenCalledWith('1.4.0');
    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    const payload = (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      embeds: Array<{
        data: { title?: string; description?: string; fields?: Array<{ name: string; value: string }> };
      }>;
      components: unknown[];
    };
    expect(payload.embeds[0]?.data.title).toBe('Published · v1.4.0');
    expect(payload.embeds[0]?.data.description).toBe('Posted to 2 servers.');
    expect(payload.embeds[0]?.data.fields?.some((field) => field.name === 'Failed')).toBe(true);
    expect(payload.embeds[0]?.data.fields?.find((field) => field.name === 'Failed')?.value).toBe(
      'Could not post in guild `g-fail`: Missing access',
    );
    expect(payload.components).toEqual([]);
  });

  it('dismisses the draft and strips buttons', async () => {
    const interaction = releaseInteraction('changelog:dismiss:1.4.0');

    await expect(handleReleaseInteraction(interaction)).resolves.toBe(true);
    expect(dismissRelease).toHaveBeenCalledWith('1.4.0');
    const payload = (interaction.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      embeds: Array<{ data: { title?: string } }>;
      components: unknown[];
    };
    expect(payload.embeds[0]?.data.title).toBe('Dismissed · v1.4.0');
    expect(payload.components).toEqual([]);
  });
});
