import { describe, expect, it } from 'vitest';
import {
  heroRankPositions,
  coldStartKi,
  competitionRank,
  parseRankOptions,
  RANK_HERO_TOP,
  sortRankProfileHeroes,
  type PlayerProfileHero,
} from './player-profile.js';
import { displayOrdinal } from '../rating/rating-math.js';

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

function hero(
  heroId: number,
  matchesPlayed: number,
  ki: number,
  name = `Hero${heroId}`,
): PlayerProfileHero {
  return {
    heroId,
    name,
    ki,
    matchesPlayed,
    wins: 0,
    losses: 0,
    winRatePercent: null,
  };
}

describe('sortRankProfileHeroes', () => {
  it(`returns at most ${RANK_HERO_TOP} heroes sorted by matches played`, () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      hero(index + 1, 12 - index, 3000 + index),
    );
    const sorted = sortRankProfileHeroes(rows);
    expect(sorted).toHaveLength(RANK_HERO_TOP);
    expect(sorted.map((row) => row.heroId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('tie-breaks equal matches by ki desc then name', () => {
    const sorted = sortRankProfileHeroes([
      hero(1, 5, 3900, 'Vegeta'),
      hero(2, 5, 4200, 'Goku'),
      hero(3, 5, 4200, 'Bardock'),
    ]);
    expect(sorted.map((row) => row.name)).toEqual(['Bardock', 'Goku', 'Vegeta']);
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
    expect(parseRankOptions({ selfDiscordId: 'me', userDiscordId: 'u1', nick: null })).toEqual({
      kind: 'user',
      discordId: 'u1',
    });
  });

  it('uses nick when only nick set', () => {
    expect(parseRankOptions({ selfDiscordId: 'me', userDiscordId: null, nick: 'Tinys' })).toEqual({
      kind: 'nick',
      nick: 'tinys',
    });
  });

  it('trims and lowercases nick lookups', () => {
    expect(parseRankOptions({ selfDiscordId: 'me', nick: '  GHOST  ' })).toEqual({
      kind: 'nick',
      nick: 'ghost',
    });
  });

  it('defaults to self', () => {
    expect(parseRankOptions({ selfDiscordId: 'me' })).toEqual({
      kind: 'self',
      discordId: 'me',
    });
  });
});

describe('heroRankPositions', () => {
  const row = (playerId: string, heroId: number, mu: number) => ({
    playerId,
    heroId,
    mu,
    sigma: 2,
    matchesPlayed: 10,
    player: { username: playerId },
  });
  const games = new Map([
    ['me', 10],
    ['a', 10],
    ['b', 10],
    ['rookie', 2],
  ]);

  it('ranks the player per hero like the hero leaderboard', () => {
    const ranks = heroRankPositions(
      [row('a', 1, 40), row('me', 1, 30), row('b', 1, 20), row('me', 2, 50), row('a', 2, 10)],
      'me',
      games,
    );
    expect(ranks.get(1)).toBe(2);
    expect(ranks.get(2)).toBe(1);
  });

  it('ignores calibrating players above and returns null while calibrating', () => {
    expect(heroRankPositions([row('rookie', 1, 50), row('me', 1, 30)], 'me', games).get(1)).toBe(1);
    expect(heroRankPositions([row('rookie', 1, 50)], 'rookie', games).get(1)).toBeNull();
  });

  it('shares the place on ties and omits heroes without a row', () => {
    const ranks = heroRankPositions([row('a', 1, 30), row('me', 1, 30)], 'me', games);
    expect(ranks.get(1)).toBe(1);
    expect(ranks.has(2)).toBe(false);
  });
});
