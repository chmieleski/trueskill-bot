import type { CaptainDraft } from '@dbz/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTeamsFromCaptains } from './draft-logic.js';
import { serializeDraftState } from './draft-state.js';
import type { DraftParticipant, DraftState } from './draft-types.js';

const channelSend = vi.fn();
const channelEdit = vi.fn();
const channelsFetch = vi.fn();

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    captainDraftDisplay: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    },
  },
}));

import { notifyOnClockCaptainIfChanged, syncLiveDraftMessage } from './draft-display-sync.js';

const p = (key: string, label: string, discordId?: string): DraftParticipant =>
  discordId ? { key, label, discordId } : { key, label };

function activeState(pickIndex = 0): DraftState {
  const captains = [p('c0', 'Alice', '111'), p('c1', 'Bob', '222')];
  const pickOrder = [0, 1];
  const teams = buildTeamsFromCaptains(captains, pickOrder);

  return {
    captains,
    memberPool: [p('m0', 'Eve', '333'), p('m1', 'Frank')],
    pickOrder,
    teams,
    pickIndex,
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

function mockClient() {
  channelSend.mockResolvedValue({ id: 'ping-msg-1' });
  channelEdit.mockResolvedValue(undefined);
  channelsFetch.mockResolvedValue({
    isTextBased: () => true,
    isDMBased: () => false,
    messages: { edit: channelEdit },
    send: channelSend,
  });

  return { channels: { fetch: channelsFetch } } as never;
}

describe('notifyOnClockCaptainIfChanged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a ping when the on-clock captain changes', async () => {
    const previousState = activeState(0);
    const nextState = activeState(1);
    const draft = asDraftRow(nextState);
    const client = mockClient();

    await notifyOnClockCaptainIfChanged(client, draft, previousState);

    expect(channelSend).toHaveBeenCalledWith({
      content: '<@222> — your turn to pick!',
      allowedMentions: { users: ['222'] },
    });
  });

  it('does not ping when the on-clock captain is unchanged', async () => {
    const state = activeState(0);
    const draft = asDraftRow(state);
    const client = mockClient();

    await notifyOnClockCaptainIfChanged(client, draft, state);

    expect(channelSend).not.toHaveBeenCalled();
  });

  it('does not ping when previous state is omitted', async () => {
    const draft = asDraftRow(activeState(1));
    const client = mockClient();

    await notifyOnClockCaptainIfChanged(client, draft);

    expect(channelSend).not.toHaveBeenCalled();
  });

  it('does not ping text-only captains without a Discord id', async () => {
    const previousState = activeState(0);
    const nextState = activeState(1);
    nextState.teams[1]!.captainKey = nextState.captains[1]!.key;
    nextState.captains[1] = p('c1', 'Bob');
    nextState.teams[1]!.roster[0] = nextState.captains[1]!;

    const draft = asDraftRow(nextState);
    const client = mockClient();

    await notifyOnClockCaptainIfChanged(client, draft, previousState);

    expect(channelSend).not.toHaveBeenCalled();
  });
});

describe('syncLiveDraftMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pings the next captain after editing the live draft card', async () => {
    const previousState = activeState(0);
    const nextState = activeState(1);
    const draft = asDraftRow(nextState);
    const client = mockClient();

    await syncLiveDraftMessage(client, draft, { previousState });

    expect(channelEdit).toHaveBeenCalled();
    expect(channelSend).toHaveBeenCalledWith({
      content: '<@222> — your turn to pick!',
      allowedMentions: { users: ['222'] },
    });
  });
});
