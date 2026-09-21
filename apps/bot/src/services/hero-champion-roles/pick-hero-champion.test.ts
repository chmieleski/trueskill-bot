import { describe, expect, it } from 'vitest';
import { pickHeroChampion } from './pick-hero-champion.js';

describe('pickHeroChampion', () => {
  const alice = { discordId: 'a', ki: 5000, username: 'alice' };
  const bob = { discordId: 'b', ki: 5000, username: 'bob' };
  const carol = { discordId: 'c', ki: 4800, username: 'carol' };

  it('returns null when there are no candidates', () => {
    expect(pickHeroChampion({ candidates: [], incumbentDiscordId: 'a' })).toBeNull();
  });

  it('picks the highest ki when there is no incumbent', () => {
    expect(
      pickHeroChampion({
        candidates: [carol, alice],
        incumbentDiscordId: null,
      }),
    ).toBe('a');
  });

  it('keeps the sticky incumbent on an exact ki tie', () => {
    expect(
      pickHeroChampion({
        candidates: [alice, bob],
        incumbentDiscordId: 'b',
      }),
    ).toBe('b');
  });

  it('switches when someone strictly exceeds the incumbent', () => {
    expect(
      pickHeroChampion({
        candidates: [
          { discordId: 'b', ki: 5000, username: 'bob' },
          { discordId: 'a', ki: 5100, username: 'alice' },
        ],
        incumbentDiscordId: 'b',
      }),
    ).toBe('a');
  });

  it('awards top when incumbent is no longer eligible', () => {
    expect(
      pickHeroChampion({
        candidates: [alice, carol],
        incumbentDiscordId: 'missing',
      }),
    ).toBe('a');
  });

  it('breaks non-incumbent ties by username', () => {
    expect(
      pickHeroChampion({
        candidates: [bob, alice],
        incumbentDiscordId: null,
      }),
    ).toBe('a');
  });
});
