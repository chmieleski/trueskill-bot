import { describe, expect, it } from 'vitest';
import type { DraftParticipant, DraftState } from './draft-types.js';
import { buildTeamsFromCaptains } from './draft-logic.js';
import {
  buildLiveDraftContent,
  buildLiveDraftEmbeds,
  buildLiveDraftMessage,
} from './draft-live-embed.js';

const p = (key: string, label: string, discordId?: string): DraftParticipant =>
  discordId ? { key, label, discordId } : { key, label };

function activeState(): DraftState {
  const captains = [p('c0', 'Alice', '111'), p('c1', 'Bob', '222')];
  const pickOrder = [0, 1];
  const teams = buildTeamsFromCaptains(captains, pickOrder);
  teams[0]!.displayName = 'Team Alice';
  teams[1]!.displayName = 'Team Bob';

  return {
    captains,
    memberPool: [p('m0', 'Eve', '333'), p('m1', 'Frank')],
    pickOrder,
    teams,
    pickIndex: 0,
  };
}

describe('buildLiveDraftContent', () => {
  it('pings the on-clock captain during an active draft', () => {
    const content = buildLiveDraftContent(activeState(), 'ACTIVE');
    expect(content).toBe('<@111> — your turn to pick!');
  });

  it('returns empty content when the draft is complete', () => {
    const state = activeState();
    state.memberPool = [];
    expect(buildLiveDraftContent(state, 'ACTIVE')).toBe('');
    expect(buildLiveDraftContent(state, 'COMPLETE')).toBe('');
  });
});

describe('buildLiveDraftEmbeds', () => {
  it('builds one embed per team plus an available pool embed', () => {
    const embeds = buildLiveDraftEmbeds(activeState(), 'ACTIVE');
    expect(embeds).toHaveLength(3);
    expect(embeds[0]!.data.title).toBe('🎯 Team Alice');
    expect(embeds[1]!.data.title).toBe('Team Bob');
    expect(embeds[2]!.data.title).toBe('Available (2)');
    expect(embeds[0]!.data.fields?.[2]?.value).toContain('<@111> 👑');
    expect(embeds[0]!.data.fields?.[2]?.value).not.toContain('```');
  });
});

describe('buildLiveDraftMessage', () => {
  it('includes captain ping, embeds, and pick button components', () => {
    const payload = buildLiveDraftMessage('draft-1', activeState(), 'ACTIVE');
    expect(payload.content).toContain('<@111>');
    expect(payload.embeds).toHaveLength(3);
    expect(payload.components).toHaveLength(1);
    expect(payload.components[0]?.components[0]?.data.custom_id).toBe('cdraft:pick_btn:draft-1');
  });
});
