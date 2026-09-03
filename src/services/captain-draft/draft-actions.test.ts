import type { CaptainDraft } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  captainDraftFindFirst,
  captainDraftFindUnique,
  captainDraftCreate,
  captainDraftUpdate,
  leagueFindUnique,
  resolveParticipantsFromInput,
  syncLiveDraftMessage,
  refreshPublishedTeamsIfAny,
} = vi.hoisted(() => ({
  captainDraftFindFirst: vi.fn(),
  captainDraftFindUnique: vi.fn(),
  captainDraftCreate: vi.fn(),
  captainDraftUpdate: vi.fn(),
  leagueFindUnique: vi.fn(),
  resolveParticipantsFromInput: vi.fn(),
  syncLiveDraftMessage: vi.fn(),
  refreshPublishedTeamsIfAny: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    captainDraft: {
      findFirst: captainDraftFindFirst,
      findUnique: captainDraftFindUnique,
      create: captainDraftCreate,
      update: captainDraftUpdate,
    },
    league: { findUnique: leagueFindUnique },
    captainDraftDisplay: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('./draft-resolve.js', () => ({
  resolveParticipantsFromInput,
}));

vi.mock('./draft-display-sync.js', () => ({
  syncLiveDraftMessage,
  refreshPublishedTeamsIfAny,
  publishTeamRosters: vi.fn(),
}));

import {
  applyCaptainDraftPick,
  beginCaptainDraft,
  cancelCaptainDraft,
  renameCaptainTeam,
  setCaptains,
  setMembers,
  startCaptainDraft,
} from './draft-actions.js';
import { buildTeamsFromCaptains } from './draft-logic.js';
import { serializeDraftState } from './draft-state.js';
import type { DraftParticipant, DraftState } from './draft-types.js';
import { CaptainDraftError, emptyDraftState } from './draft-types.js';

const p = (key: string, label = key, discordId?: string): DraftParticipant =>
  discordId ? { key, label, discordId } : { key, label };

function asDraftRow(state: DraftState, overrides: Partial<CaptainDraft> = {}): CaptainDraft {
  return {
    id: 'draft-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    hostDiscordId: 'host-1',
    leagueId: null,
    status: 'SETUP',
    state: serializeDraftState(state),
    draftMessageId: null,
    createdAt: new Date('2026-08-31T00:00:00.000Z'),
    updatedAt: new Date('2026-08-31T00:00:00.000Z'),
    ...overrides,
  };
}

function mockTextChannel() {
  const send = vi.fn().mockResolvedValue({ id: 'live-msg-1' });
  const messagesDelete = vi.fn().mockResolvedValue(undefined);
  return {
    isTextBased: () => true,
    isDMBased: () => false,
    send,
    messages: { delete: messagesDelete },
  };
}

describe('startCaptainDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a draft when none is active in the channel', async () => {
    captainDraftFindFirst.mockResolvedValue(null);
    captainDraftCreate.mockResolvedValue(asDraftRow(emptyDraftState(), { id: 'new-draft' }));

    const result = await startCaptainDraft({
      guildId: 'guild-1',
      channelId: 'channel-1',
      hostDiscordId: 'host-1',
    });

    expect(captainDraftCreate).toHaveBeenCalled();
    expect(result.id).toBe('new-draft');
  });

  it('rejects when an active draft already exists', async () => {
    captainDraftFindFirst.mockResolvedValue(asDraftRow(emptyDraftState()));

    await expect(
      startCaptainDraft({
        guildId: 'guild-1',
        channelId: 'channel-1',
        hostDiscordId: 'host-1',
      }),
    ).rejects.toThrow(CaptainDraftError);
  });
});

describe('setCaptains', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaces captains during SETUP', async () => {
    const state = emptyDraftState();
    captainDraftFindUnique.mockResolvedValue(asDraftRow(state));
    resolveParticipantsFromInput.mockResolvedValue([p('c0', 'Alice', '111')]);
    captainDraftUpdate.mockImplementation(async ({ data }) =>
      asDraftRow(data.state as DraftState, { status: data.status as CaptainDraft['status'] }),
    );

    await setCaptains({
      draftId: 'draft-1',
      guild: {} as never,
      raw: '@Alice',
      gameId: null,
    });

    expect(captainDraftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'draft-1' },
        data: expect.objectContaining({
          status: 'SETUP',
          state: expect.objectContaining({
            captains: [p('c0', 'Alice', '111')],
            teams: [],
            pickOrder: [],
            pickIndex: 0,
          }),
        }),
      }),
    );
  });

  it('rejects when draft is not in SETUP', async () => {
    captainDraftFindUnique.mockResolvedValue(asDraftRow(emptyDraftState(), { status: 'ACTIVE' }));

    await expect(
      setCaptains({ draftId: 'draft-1', guild: {} as never, raw: 'Alice', gameId: null }),
    ).rejects.toThrow(/setup/i);
  });
});

describe('setMembers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaces members and excludes captains', async () => {
    const state = {
      ...emptyDraftState(),
      captains: [p('c0', 'Alice', '111')],
    };
    captainDraftFindUnique.mockResolvedValue(asDraftRow(state));
    resolveParticipantsFromInput.mockResolvedValue([p('m0', 'Dave'), p('c0', 'Alice', '111')]);
    captainDraftUpdate.mockResolvedValue(asDraftRow(state));

    await setMembers({
      draftId: 'draft-1',
      guild: {} as never,
      raw: 'Dave, Alice',
      gameId: null,
    });

    expect(captainDraftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: expect.objectContaining({
            memberPool: [p('m0', 'Dave')],
          }),
        }),
      }),
    );
  });
});

describe('beginCaptainDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shuffles, builds teams, posts live embed, and sets ACTIVE', async () => {
    const captains = [p('c0', 'Alice', '111'), p('c1', 'Bob', '222')];
    const state = {
      ...emptyDraftState(),
      captains,
      memberPool: [p('m0', 'Dave')],
    };
    captainDraftFindUnique.mockResolvedValue(asDraftRow(state));
    captainDraftUpdate.mockImplementation(async ({ data, ...rest }) => {
      void rest;
      return asDraftRow(data.state as DraftState, {
        status: data.status as CaptainDraft['status'],
        draftMessageId: data.draftMessageId as string,
      });
    });

    const channel = mockTextChannel();
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue(channel) },
    } as never;

    const result = await beginCaptainDraft({
      client,
      draftId: 'draft-1',
      rng: () => 0,
    });

    expect(channel.send).toHaveBeenCalledOnce();
    expect(captainDraftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'ACTIVE',
          draftMessageId: 'live-msg-1',
        }),
      }),
    );
    expect(result.status).toBe('ACTIVE');
  });

  it('requires at least two captains', async () => {
    captainDraftFindUnique.mockResolvedValue(
      asDraftRow({
        ...emptyDraftState(),
        captains: [p('c0')],
        memberPool: [p('m0')],
      }),
    );

    await expect(beginCaptainDraft({ client: {} as never, draftId: 'draft-1' })).rejects.toThrow(
      /captain/i,
    );
  });

  it('requires at least one member', async () => {
    captainDraftFindUnique.mockResolvedValue(
      asDraftRow({
        ...emptyDraftState(),
        captains: [p('c0'), p('c1')],
        memberPool: [],
      }),
    );

    await expect(beginCaptainDraft({ client: {} as never, draftId: 'draft-1' })).rejects.toThrow(
      /member/i,
    );
  });
});

describe('applyCaptainDraftPick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('completes the draft when the pool is exhausted', async () => {
    const captains = [p('c0', 'Alice', '111'), p('c1', 'Bob', '222')];
    const pickOrder = [0, 1];
    const teams = buildTeamsFromCaptains(captains, pickOrder);
    const state: DraftState = {
      captains,
      memberPool: [p('m0', 'Dave')],
      pickOrder,
      teams,
      pickIndex: 0,
    };
    captainDraftFindUnique.mockResolvedValue(
      asDraftRow(state, { status: 'ACTIVE', draftMessageId: 'live-msg-1' }),
    );
    captainDraftUpdate.mockImplementation(async ({ data }) =>
      asDraftRow(data.state as DraftState, {
        status: data.status as CaptainDraft['status'],
        draftMessageId: 'live-msg-1',
      }),
    );

    const saved = await applyCaptainDraftPick({
      client: {} as never,
      draftId: 'draft-1',
      actorDiscordId: '111',
      participantKey: 'm0',
    });

    expect(saved.status).toBe('COMPLETE');
    expect(syncLiveDraftMessage).toHaveBeenCalled();
    expect(refreshPublishedTeamsIfAny).toHaveBeenCalled();
  });
});

describe('renameCaptainTeam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('heals an ACTIVE empty-pool draft then renames the team', async () => {
    const captains = [p('c0', 'Alice', '111'), p('c1', 'Bob', '222')];
    const pickOrder = [0, 1];
    const teams = buildTeamsFromCaptains(captains, pickOrder);
    const state: DraftState = {
      captains,
      memberPool: [],
      pickOrder,
      teams,
      pickIndex: 2,
    };
    captainDraftFindUnique.mockResolvedValue(
      asDraftRow(state, { status: 'ACTIVE', draftMessageId: 'live-msg-1' }),
    );
    captainDraftUpdate.mockImplementation(async ({ data }) =>
      asDraftRow(data.state as DraftState, {
        status: data.status as CaptainDraft['status'],
        draftMessageId: 'live-msg-1',
      }),
    );

    const saved = await renameCaptainTeam({
      client: {} as never,
      draftId: 'draft-1',
      actorDiscordId: '111',
      captainKey: 'c0',
      name: 'Team Dragon',
    });

    expect(captainDraftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'COMPLETE' }),
      }),
    );
    expect(saved.status).toBe('COMPLETE');
    expect(
      (saved.state as DraftState).teams.find((team) => team.captainKey === 'c0')?.displayName,
    ).toBe('Team Dragon');
  });
});

describe('cancelCaptainDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks the draft cancelled and deletes the live message', async () => {
    const state = emptyDraftState();
    captainDraftFindFirst.mockResolvedValue(
      asDraftRow(state, { status: 'ACTIVE', draftMessageId: 'live-msg-1' }),
    );
    captainDraftUpdate.mockResolvedValue(asDraftRow(state, { status: 'CANCELLED' }));

    const channel = mockTextChannel();
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue(channel) },
    } as never;

    const saved = await cancelCaptainDraft({
      client,
      guildId: 'guild-1',
      channelId: 'channel-1',
    });

    expect(saved.status).toBe('CANCELLED');
    expect(channel.messages.delete).toHaveBeenCalledWith('live-msg-1');
  });
});
