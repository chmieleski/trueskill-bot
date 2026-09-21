import { describe, expect, it } from 'vitest';
import { teamFromCaptainDraftTeam } from './draft-teams.js';
import type { DraftState } from '../captain-draft/draft-types.js';

describe('teamFromCaptainDraftTeam', () => {
  it('maps a completed captain-draft team to hero-draft shape', () => {
    const state: DraftState = {
      captains: [{ key: 'c0', label: 'Alice', discordId: '111' }],
      memberPool: [],
      pickOrder: [0],
      pickIndex: 0,
      teams: [
        {
          captainKey: 'c0',
          displayName: 'Team Alice',
          pickOrderIndex: 0,
          roster: [
            { key: 'c0', label: 'Alice', discordId: '111' },
            { key: 'm1', label: 'Bob', discordId: '222' },
          ],
        },
      ],
    };

    const team = teamFromCaptainDraftTeam(state, 'c0', 1);
    expect(team.side).toBe(1);
    expect(team.displayName).toBe('Team Alice');
    expect(team.captain.discordId).toBe('111');
    expect(team.roster).toHaveLength(2);
    expect(team.bans).toEqual([]);
    expect(team.picks).toEqual([]);
  });
});
