import { describe, expect, it } from 'vitest';
import type { DraftParticipant, DraftState } from './draft-types.js';
import { buildTeamsFromCaptains } from './draft-logic.js';
import {
  TEAM_EMBED_COLORS,
  buildTeamRosterEmbeds,
  formatParticipantDisplay,
  formatTeamRosterTable,
} from './draft-team-embed.js';

const p = (key: string, label: string, discordId?: string): DraftParticipant =>
  discordId ? { key, label, discordId } : { key, label };

function sampleState(): DraftState {
  const captains = [p('c0', 'Alice', '111'), p('c1', 'Bob', '222')];
  const pickOrder = [0, 1];
  const teams = buildTeamsFromCaptains(captains, pickOrder);
  teams[0]!.roster.push(p('m0', 'Eve', '333'));
  teams[1]!.roster.push(p('m1', 'Frank'));
  teams[0]!.displayName = 'Team Alice';
  teams[1]!.displayName = 'Team Bob';

  return {
    captains,
    memberPool: [],
    pickOrder,
    teams,
    pickIndex: 2,
  };
}

describe('formatParticipantDisplay', () => {
  it('uses Discord mention when linked', () => {
    expect(formatParticipantDisplay(p('a', 'Alice', '999'))).toBe('<@999>');
  });

  it('uses plain label when unlinked', () => {
    expect(formatParticipantDisplay(p('a', 'Alice'))).toBe('Alice');
  });
});

describe('formatTeamRosterTable', () => {
  it('marks the captain and aligns columns', () => {
    const team = sampleState().teams[0]!;
    const table = formatTeamRosterTable(team);
    expect(table).toContain('#');
    expect(table).toContain('Player');
    expect(table).toContain('👑 <@111>');
    expect(table).toContain('<@333>');
  });
});

describe('buildTeamRosterEmbeds', () => {
  const completedAt = new Date('2026-08-31T15:00:00Z');

  it('builds one embed per team with rotating colors', () => {
    const embeds = buildTeamRosterEmbeds(sampleState(), completedAt);
    expect(embeds).toHaveLength(2);
    expect(embeds[0]!.data.title).toBe('Team Alice');
    expect(embeds[0]!.data.color).toBe(TEAM_EMBED_COLORS[0]);
    expect(embeds[1]!.data.color).toBe(TEAM_EMBED_COLORS[1]);
    expect(embeds[0]!.data.description).toContain('👑 <@111>');
    expect(embeds[0]!.data.fields?.[0]?.name).toBe('Roster');
    expect(embeds[0]!.data.fields?.[0]?.value).toContain('<@333>');
  });

  it('puts footer only on the last team embed', () => {
    const embeds = buildTeamRosterEmbeds(sampleState(), completedAt);
    expect(embeds[0]!.data.footer).toBeUndefined();
    expect(embeds[1]!.data.footer?.text).toMatch(/^Captain draft · Aug 31, 2026 · Pick order #/);
    expect(embeds[1]!.data.footer?.text).toContain('Pick order #2');
  });

  it('sorts teams by pick order index', () => {
    const state = sampleState();
    state.teams = [...state.teams].reverse();
    const embeds = buildTeamRosterEmbeds(state, completedAt);
    expect(embeds[0]!.data.title).toBe('Team Alice');
    expect(embeds[1]!.data.title).toBe('Team Bob');
  });
});
