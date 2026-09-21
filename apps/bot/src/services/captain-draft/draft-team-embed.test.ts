import { describe, expect, it } from 'vitest';
import type { DraftParticipant, DraftState } from './draft-types.js';
import { buildTeamsFromCaptains } from './draft-logic.js';
import {
  TEAM_EMBED_COLORS,
  buildTeamRosterEmbeds,
  formatParticipantDisplay,
  formatTeamRosterList,
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

describe('formatTeamRosterList', () => {
  it('marks the captain with a crown outside code blocks', () => {
    const team = sampleState().teams[0]!;
    const roster = formatTeamRosterList(team);
    expect(roster).toContain('- <@111> 👑');
    expect(roster).toContain('- <@333>');
    expect(roster).not.toContain('```');
  });
});

describe('buildTeamRosterEmbeds', () => {
  const completedAt = new Date('2026-08-31T15:00:00Z');

  it('builds one embed per team with captain, pick order, and roster fields', () => {
    const embeds = buildTeamRosterEmbeds(sampleState(), completedAt);
    expect(embeds).toHaveLength(2);
    expect(embeds[0]!.data.title).toBe('Team Alice');
    expect(embeds[0]!.data.color).toBe(TEAM_EMBED_COLORS[0]);
    expect(embeds[1]!.data.color).toBe(TEAM_EMBED_COLORS[1]);

    const fields = embeds[0]!.data.fields ?? [];
    expect(fields.map((field) => field.name)).toEqual(['Captain', 'Pick Order', 'Roster']);
    expect(fields[0]?.value).toBe('<@111>');
    expect(fields[1]?.value).toBe('#1');
    expect(fields[2]?.value).toContain('<@111> 👑');
    expect(fields[2]?.value).toContain('<@333>');
    expect(fields[2]?.value).not.toContain('```');
  });

  it('puts extended footer only on the last team embed', () => {
    const embeds = buildTeamRosterEmbeds(sampleState(), completedAt);
    expect(embeds[0]!.data.footer?.text).toBe('Captain draft');
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
