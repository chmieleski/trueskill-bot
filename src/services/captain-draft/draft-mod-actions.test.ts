import type { CaptainDraft } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  captainDraftFindFirst,
  captainDraftUpdate,
  syncLiveDraftMessage,
  refreshPublishedTeamsIfAny,
} = vi.hoisted(() => ({
  captainDraftFindFirst: vi.fn(),
  captainDraftUpdate: vi.fn(),
  syncLiveDraftMessage: vi.fn(),
  refreshPublishedTeamsIfAny: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    captainDraft: {
      findFirst: captainDraftFindFirst,
      update: captainDraftUpdate,
    },
    captainDraftDisplay: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('./draft-display-sync.js', () => ({
  syncLiveDraftMessage,
  refreshPublishedTeamsIfAny,
}));

import {
  modAddPlayer,
  modForcePick,
  modRemovePlayer,
  modReplacePlayer,
  modUndoPick,
} from './draft-mod-actions.js';
import { buildTeamsFromCaptains } from './draft-logic.js';
import { serializeDraftState } from './draft-state.js';
import type { DraftParticipant, DraftState } from './draft-types.js';
import { CaptainDraftError } from './draft-types.js';

const p = (key: string, label = key, discordId?: string): DraftParticipant =>
  discordId ? { key, label, discordId } : { key, label };

function activeStateWithPick(): DraftState {
  const captains = [p('c0', 'Alice', '111'), p('c1', 'Bob', '222')];
  const pickOrder = [0, 1];
  const teams = buildTeamsFromCaptains(captains, pickOrder);
  teams[0] = { ...teams[0]!, roster: [...teams[0]!.roster, p('m0', 'Dave')] };
  return {
    captains,
    memberPool: [p('m1', 'Eve')],
    pickOrder,
    teams,
    pickIndex: 1,
  };
}

function asDraftRow(state: DraftState, overrides: Partial<CaptainDraft> = {}): CaptainDraft {
  return {
    id: 'draft-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    hostDiscordId: 'host-1',
    leagueId: null,
    status: 'ACTIVE',
    state: serializeDraftState(state),
    draftMessageId: 'live-msg-1',
    createdAt: new Date('2026-08-31T00:00:00.000Z'),
    updatedAt: new Date('2026-08-31T00:00:00.000Z'),
    ...overrides,
  };
}

describe('modUndoPick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reverts the last pick and refreshes the live embed', async () => {
    const state = activeStateWithPick();
    captainDraftFindFirst.mockResolvedValue(asDraftRow(state));
    captainDraftUpdate.mockImplementation(async ({ data }) =>
      asDraftRow(data.state as DraftState, { status: data.status as CaptainDraft['status'] }),
    );

    await modUndoPick({
      client: {} as never,
      guildId: 'guild-1',
      channelId: 'channel-1',
    });

    expect(captainDraftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: expect.objectContaining({ pickIndex: 0 }),
        }),
      }),
    );
    expect(syncLiveDraftMessage).toHaveBeenCalled();
  });

  it('rejects undo when no picks have been made', async () => {
    const state = activeStateWithPick();
    state.pickIndex = 0;
    state.teams = buildTeamsFromCaptains(state.captains, state.pickOrder);
    captainDraftFindFirst.mockResolvedValue(asDraftRow(state));

    await expect(
      modUndoPick({ client: {} as never, guildId: 'guild-1', channelId: 'channel-1' }),
    ).rejects.toThrow(CaptainDraftError);
  });
});

describe('modForcePick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('assigns the current pick without captain auth', async () => {
    const captains = [p('c0', 'Alice', '111'), p('c1', 'Bob', '222')];
    const pickOrder = [0, 1];
    const state: DraftState = {
      captains,
      memberPool: [p('m0', 'Dave'), p('m1', 'Eve')],
      pickOrder,
      teams: buildTeamsFromCaptains(captains, pickOrder),
      pickIndex: 0,
    };
    captainDraftFindFirst.mockResolvedValue(asDraftRow(state));
    captainDraftUpdate.mockImplementation(async ({ data }) =>
      asDraftRow(data.state as DraftState, {
        status: data.status as CaptainDraft['status'],
        draftMessageId: 'live-msg-1',
      }),
    );

    await modForcePick({
      client: {} as never,
      guildId: 'guild-1',
      channelId: 'channel-1',
      participantKey: 'm0',
    });

    expect(captainDraftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: expect.objectContaining({ pickIndex: 1 }),
        }),
      }),
    );
    expect(syncLiveDraftMessage).toHaveBeenCalled();
    expect(refreshPublishedTeamsIfAny).toHaveBeenCalled();
  });
});

describe('modRemovePlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks ACTIVE complete when the last pool player is removed', async () => {
    const state = activeStateWithPick();
    captainDraftFindFirst.mockResolvedValue(asDraftRow(state));
    captainDraftUpdate.mockImplementation(async ({ data }) =>
      asDraftRow(data.state as DraftState, {
        status: data.status as CaptainDraft['status'],
        draftMessageId: 'live-msg-1',
      }),
    );

    const saved = await modRemovePlayer({
      client: {} as never,
      guildId: 'guild-1',
      channelId: 'channel-1',
      participantKey: 'm1',
    });

    expect(captainDraftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'COMPLETE' }),
      }),
    );
    expect(saved.status).toBe('COMPLETE');
    expect(syncLiveDraftMessage).toHaveBeenCalled();
  });

  it('does not complete a SETUP draft when the pool is emptied', async () => {
    const state: DraftState = {
      captains: [p('c0'), p('c1')],
      memberPool: [p('m0')],
      pickOrder: [],
      teams: [],
      pickIndex: 0,
    };
    captainDraftFindFirst.mockResolvedValue(asDraftRow(state, { status: 'SETUP' }));
    captainDraftUpdate.mockImplementation(async ({ data }) =>
      asDraftRow(data.state as DraftState, { status: data.status as CaptainDraft['status'] }),
    );

    const saved = await modRemovePlayer({
      client: {} as never,
      guildId: 'guild-1',
      channelId: 'channel-1',
      participantKey: 'm0',
    });

    expect(captainDraftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SETUP' }),
      }),
    );
    expect(saved.status).toBe('SETUP');
  });
});

describe('modAddPlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends a new player to the pool during SETUP', async () => {
    const state: DraftState = {
      captains: [p('c0'), p('c1')],
      memberPool: [p('m0')],
      pickOrder: [],
      teams: [],
      pickIndex: 0,
    };
    captainDraftFindFirst.mockResolvedValue(asDraftRow(state, { status: 'SETUP' }));
    captainDraftUpdate.mockImplementation(async ({ data }) =>
      asDraftRow(data.state as DraftState, { status: data.status as CaptainDraft['status'] }),
    );

    await modAddPlayer({
      client: {} as never,
      guildId: 'guild-1',
      channelId: 'channel-1',
      player: p('m9', 'Zed'),
    });

    expect(captainDraftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: expect.objectContaining({
            memberPool: expect.arrayContaining([p('m9', 'Zed')]),
          }),
        }),
      }),
    );
  });

  it('adds directly to a team when team is specified during ACTIVE', async () => {
    const state = activeStateWithPick();
    captainDraftFindFirst.mockResolvedValue(asDraftRow(state));
    captainDraftUpdate.mockImplementation(async ({ data }) =>
      asDraftRow(data.state as DraftState, { status: data.status as CaptainDraft['status'] }),
    );

    await modAddPlayer({
      client: {} as never,
      guildId: 'guild-1',
      channelId: 'channel-1',
      player: p('m9', 'Zed'),
      teamCaptainKey: 'c1',
    });

    expect(captainDraftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: expect.objectContaining({
            teams: expect.arrayContaining([
              expect.objectContaining({
                captainKey: 'c1',
                roster: expect.arrayContaining([expect.objectContaining({ key: 'm9' })]),
              }),
            ]),
          }),
        }),
      }),
    );
    expect(syncLiveDraftMessage).toHaveBeenCalled();
  });
});

describe('modReplacePlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('substitutes a roster player during COMPLETE and refreshes published embeds', async () => {
    const state = activeStateWithPick();
    captainDraftFindFirst.mockResolvedValue(asDraftRow(state, { status: 'COMPLETE' }));
    captainDraftUpdate.mockImplementation(async ({ data }) =>
      asDraftRow(data.state as DraftState, { status: data.status as CaptainDraft['status'] }),
    );

    await modReplacePlayer({
      client: {} as never,
      guildId: 'guild-1',
      channelId: 'channel-1',
      outgoingKey: 'm0',
      incoming: p('m9', 'Zed'),
    });

    expect(captainDraftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: expect.objectContaining({
            teams: expect.arrayContaining([
              expect.objectContaining({
                captainKey: 'c0',
                roster: expect.arrayContaining([
                  expect.objectContaining({ key: 'm9', label: 'Zed' }),
                ]),
              }),
            ]),
          }),
        }),
      }),
    );
    expect(refreshPublishedTeamsIfAny).toHaveBeenCalled();
  });

  it('rejects incoming players already in the draft', async () => {
    const state = activeStateWithPick();
    captainDraftFindFirst.mockResolvedValue(asDraftRow(state));

    await expect(
      modReplacePlayer({
        client: {} as never,
        guildId: 'guild-1',
        channelId: 'channel-1',
        outgoingKey: 'm0',
        incoming: p('m1', 'Eve'),
      }),
    ).rejects.toThrow(CaptainDraftError);
  });
});
