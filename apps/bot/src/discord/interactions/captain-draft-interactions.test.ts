import type { Interaction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptainDraftError } from '../../services/captain-draft/index.js';
import { clearEphemeralSessionsForTests } from '../../lib/ephemeral-session.js';

const { loadDraftById, applyCaptainDraftPick } = vi.hoisted(() => ({
  loadDraftById: vi.fn(),
  applyCaptainDraftPick: vi.fn(),
}));

vi.mock('../../services/captain-draft/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/captain-draft/index.js')>();
  return {
    ...actual,
    loadDraftById,
    applyCaptainDraftPick,
  };
});

import {
  buildPickSelectCustomId,
  handleCaptainDraftInteraction,
  parseCaptainDraftPickCustomId,
} from './captain-draft-interactions.js';

const DRAFT_ID = 'draft-1';
const CAPTAIN_ID = 'captain-1';
const POOL = Array.from({ length: 3 }, (_, index) => ({
  key: `player-${index}`,
  label: `Player ${index}`,
}));

const ACTIVE_STATE = {
  captains: [{ key: 'cap-1', label: 'Captain', discordId: CAPTAIN_ID }],
  memberPool: POOL,
  pickOrder: [0],
  teams: [
    {
      captainKey: 'cap-1',
      displayName: 'Team Captain',
      pickOrderIndex: 0,
      roster: [{ key: 'cap-1', label: 'Captain', discordId: CAPTAIN_ID }],
    },
  ],
  pickIndex: 0,
};

function buttonInteraction(customId: string, overrides: Record<string, unknown> = {}): Interaction {
  return {
    isButton: () => true,
    isStringSelectMenu: () => false,
    customId,
    user: { id: CAPTAIN_ID },
    guildId: 'guild-1',
    channelId: 'channel-1',
    applicationId: 'app-1',
    token: 'token-1',
    client: {},
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue({ id: 'ephemeral-1' }),
    editReply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Interaction;
}

function selectInteraction(
  customId: string,
  values: string[],
  overrides: Record<string, unknown> = {},
): Interaction {
  return {
    isButton: () => false,
    isStringSelectMenu: () => true,
    customId,
    values,
    user: { id: CAPTAIN_ID },
    guildId: 'guild-1',
    channelId: 'channel-1',
    applicationId: 'app-1',
    token: 'token-1',
    client: {},
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue({ id: 'ephemeral-1' }),
    editReply: vi.fn().mockResolvedValue(undefined),
    message: { id: 'ephemeral-1' },
    ...overrides,
  } as unknown as Interaction;
}

describe('parseCaptainDraftPickCustomId', () => {
  it('parses pick button custom ids', () => {
    expect(parseCaptainDraftPickCustomId(`cdraft:pick_btn:${DRAFT_ID}`)).toEqual({
      kind: 'pick_btn',
      draftId: DRAFT_ID,
    });
  });

  it('parses pick select custom ids with page', () => {
    expect(parseCaptainDraftPickCustomId(`cdraft:pick_sel:${DRAFT_ID}:2`)).toEqual({
      kind: 'pick_sel',
      draftId: DRAFT_ID,
      page: 2,
    });
  });

  it('returns null for unrelated custom ids', () => {
    expect(parseCaptainDraftPickCustomId('lobby:start')).toBeNull();
    expect(parseCaptainDraftPickCustomId('cdraft:pick_sel:draft-1')).toBeNull();
  });
});

describe('handleCaptainDraftInteraction', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearEphemeralSessionsForTests();
    loadDraftById.mockResolvedValue({
      id: DRAFT_ID,
      status: 'ACTIVE',
      state: ACTIVE_STATE,
    });
    applyCaptainDraftPick.mockResolvedValue({
      id: DRAFT_ID,
      status: 'ACTIVE',
      state: {
        ...ACTIVE_STATE,
        memberPool: POOL.slice(1),
        pickIndex: 1,
      },
    });
  });

  it('ignores unrelated interactions', async () => {
    const interaction = buttonInteraction('lobby:start');
    await expect(handleCaptainDraftInteraction(interaction)).resolves.toBe(false);
  });

  it('shows an ephemeral select menu when the current captain clicks pick', async () => {
    const interaction = buttonInteraction(`cdraft:pick_btn:${DRAFT_ID}`);

    await expect(handleCaptainDraftInteraction(interaction)).resolves.toBe(true);

    expect(loadDraftById).toHaveBeenCalledWith(DRAFT_ID);
    expect(interaction.reply).toHaveBeenCalledOnce();
    const payload = vi.mocked(interaction.reply).mock.calls[0]![0] as {
      content?: string;
      components?: unknown[];
    };
    expect(payload.content).toMatch(/choose a player/i);
    expect(payload.components?.length).toBeGreaterThan(0);
  });

  it('rejects pick button clicks from non-current captains', async () => {
    const interaction = buttonInteraction(`cdraft:pick_btn:${DRAFT_ID}`, {
      user: { id: 'other-user' },
    });

    await expect(handleCaptainDraftInteraction(interaction)).resolves.toBe(true);

    expect(interaction.reply).toHaveBeenCalledOnce();
    const payload = vi.mocked(interaction.reply).mock.calls[0]![0] as { content?: string };
    expect(payload.content).toMatch(/not your turn/i);
    expect(applyCaptainDraftPick).not.toHaveBeenCalled();
  });

  it('applies a pick when the current captain selects a player', async () => {
    const interaction = selectInteraction(buildPickSelectCustomId(DRAFT_ID, 0), ['player-0']);

    await expect(handleCaptainDraftInteraction(interaction)).resolves.toBe(true);

    expect(applyCaptainDraftPick).toHaveBeenCalledWith({
      client: interaction.client,
      draftId: DRAFT_ID,
      actorDiscordId: CAPTAIN_ID,
      participantKey: 'player-0',
    });
    expect(interaction.update).toHaveBeenCalledOnce();
    const payload = vi.mocked(interaction.update).mock.calls[0]![0] as { content?: string };
    expect(payload.content).toMatch(/drafted/i);
  });

  it('shows the next page when the navigation option is selected', async () => {
    const largePool = Array.from({ length: 30 }, (_, index) => ({
      key: `player-${index}`,
      label: `Player ${index}`,
    }));
    loadDraftById.mockResolvedValue({
      id: DRAFT_ID,
      status: 'ACTIVE',
      state: { ...ACTIVE_STATE, memberPool: largePool },
    });

    const interaction = selectInteraction(buildPickSelectCustomId(DRAFT_ID, 0), ['__page__:1']);

    await expect(handleCaptainDraftInteraction(interaction)).resolves.toBe(true);

    expect(applyCaptainDraftPick).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledOnce();
    const payload = vi.mocked(interaction.update).mock.calls[0]![0] as {
      content?: string;
      components?: Array<{ components?: Array<{ data?: { custom_id?: string } }> }>;
    };
    expect(payload.content).toMatch(/page 2\/2/i);
    expect(payload.components?.[0]?.components?.[0]?.data?.custom_id).toBe(
      buildPickSelectCustomId(DRAFT_ID, 1),
    );
  });

  it('surfaces CaptainDraftError messages on select', async () => {
    applyCaptainDraftPick.mockRejectedValue(new CaptainDraftError('Player not in pool'));
    const interaction = selectInteraction(buildPickSelectCustomId(DRAFT_ID, 0), ['player-0']);

    await expect(handleCaptainDraftInteraction(interaction)).resolves.toBe(true);

    const payload = vi.mocked(interaction.update).mock.calls[0]![0] as { content?: string };
    expect(payload.content).toBe('Player not in pool');
  });
});
