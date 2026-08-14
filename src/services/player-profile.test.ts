import { describe, expect, it } from 'vitest';
import {
  coldStartKi,
  competitionRank,
  parseRankOptions,
  PlayerServiceError,
} from './player-profile.js';
import { displayOrdinal } from './rating-math.js';

describe('competitionRank', () => {
  it('returns 1 for the top score', () => {
    expect(competitionRank(4000, [4000, 3000, 2000])).toBe(1);
  });

  it('shares place on ties (1,2,2,4)', () => {
    const kis = [4000, 3000, 3000, 2000];
    expect(competitionRank(4000, kis)).toBe(1);
    expect(competitionRank(3000, kis)).toBe(2);
    expect(competitionRank(2000, kis)).toBe(4);
  });
});

describe('coldStartKi', () => {
  it('matches displayOrdinal defaults', () => {
    expect(coldStartKi()).toBe(displayOrdinal(25, 8.333));
  });
});

describe('parseRankOptions', () => {
  it('returns both when user and nick provided', () => {
    expect(
      parseRankOptions({
        selfDiscordId: 'me',
        userDiscordId: 'u1',
        nick: 'Tinys',
      }),
    ).toEqual({ kind: 'both' });
  });

  it('prefers user when only user set', () => {
    expect(
      parseRankOptions({ selfDiscordId: 'me', userDiscordId: 'u1', nick: null }),
    ).toEqual({ kind: 'user', discordId: 'u1' });
  });

  it('uses nick when only nick set', () => {
    expect(
      parseRankOptions({ selfDiscordId: 'me', userDiscordId: null, nick: 'Tinys' }),
    ).toEqual({ kind: 'nick', nick: 'tinys' });
  });

  it('trims and lowercases nick lookups', () => {
    expect(
      parseRankOptions({ selfDiscordId: 'me', nick: '  GHOST  ' }),
    ).toEqual({ kind: 'nick', nick: 'ghost' });
  });

  it('defaults to self', () => {
    expect(parseRankOptions({ selfDiscordId: 'me' })).toEqual({
      kind: 'self',
      discordId: 'me',
    });
  });
});
