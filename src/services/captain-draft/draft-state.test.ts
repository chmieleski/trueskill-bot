import type { CaptainDraft } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { buildTeamsFromCaptains } from './draft-logic.js';
import { parseDraftState, serializeDraftState } from './draft-state.js';
import type { DraftParticipant, DraftState } from './draft-types.js';
import { CaptainDraftError, emptyDraftState } from './draft-types.js';

const p = (key: string, label = key, discordId?: string): DraftParticipant =>
  discordId ? { key, label, discordId } : { key, label };

function sampleState(): DraftState {
  const captains = [p('c0', 'Alice', '111'), p('c1', 'Bob', '222'), p('c2', 'Carol', '333')];
  const pickOrder = [2, 0, 1];
  const teams = buildTeamsFromCaptains(captains, pickOrder);

  return {
    captains,
    memberPool: [p('m0', 'Dave'), p('m1', 'Eve', '444')],
    pickOrder,
    teams,
    pickIndex: 1,
  };
}

function asCaptainDraftRow(state: DraftState, overrides: Partial<CaptainDraft> = {}): CaptainDraft {
  return {
    id: 'draft-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    hostDiscordId: 'host-1',
    leagueId: null,
    status: 'ACTIVE',
    state: serializeDraftState(state),
    draftMessageId: 'msg-1',
    createdAt: new Date('2026-08-31T00:00:00.000Z'),
    updatedAt: new Date('2026-08-31T00:00:00.000Z'),
    ...overrides,
  };
}

describe('parseDraftState', () => {
  it('round-trips a full draft state through serialize and parse', () => {
    const state = sampleState();
    const row = asCaptainDraftRow(state);

    expect(parseDraftState(row)).toEqual(state);
  });

  it('round-trips empty draft state', () => {
    const state = emptyDraftState();
    const row = asCaptainDraftRow(state, { status: 'SETUP', draftMessageId: null });

    expect(parseDraftState(row)).toEqual(state);
  });

  it('throws on invalid persisted state', () => {
    const row = asCaptainDraftRow(emptyDraftState(), { state: 'not-json-object' });

    expect(() => parseDraftState(row)).toThrow(CaptainDraftError);
  });
});

describe('serializeDraftState', () => {
  it('produces JSON-safe data for Prisma', () => {
    const state = sampleState();
    const serialized = serializeDraftState(state);

    expect(JSON.parse(JSON.stringify(serialized))).toEqual(state);
  });
});
