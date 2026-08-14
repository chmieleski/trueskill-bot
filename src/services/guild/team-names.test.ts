import { describe, expect, it } from 'vitest';
import { teamDisplayName, teamDisplayNameForSlot } from './team-names.js';

describe('teamDisplayName', () => {
  it('maps team 1 to Z Fighters and team 2 to Evil', () => {
    expect(teamDisplayName(1)).toBe('Z Fighters');
    expect(teamDisplayName(2)).toBe('Evil');
  });
});

describe('teamDisplayNameForSlot', () => {
  it('uses team 1 for slots 1-6 and team 2 for 7-12', () => {
    expect(teamDisplayNameForSlot(1)).toBe('Z Fighters');
    expect(teamDisplayNameForSlot(6)).toBe('Z Fighters');
    expect(teamDisplayNameForSlot(7)).toBe('Evil');
    expect(teamDisplayNameForSlot(12)).toBe('Evil');
  });
});
