import { describe, expect, it } from 'vitest';
import {
  buildHeroDraftComponents,
  heroApplicationEmojiName,
  parseHeroDraftCustomId,
  resolveHeroEmojiMap,
} from './draft-ui.js';
import { emptyHeroDraftState, type HeroDraftTeam } from './draft-types.js';

const team = (side: 1 | 2): HeroDraftTeam => ({
  side,
  displayName: `Team ${side}`,
  captain: { key: `c${side}`, label: `C${side}`, discordId: `d${side}` },
  roster: [{ key: `c${side}`, label: `C${side}`, discordId: `d${side}` }],
  bans: [],
  picks: [],
});

describe('heroApplicationEmojiName', () => {
  it('uses wos_{objectId}', () => {
    expect(heroApplicationEmojiName(42)).toBe('wos_42');
  });
});

describe('resolveHeroEmojiMap', () => {
  it('attaches matching application emojis', () => {
    const map = resolveHeroEmojiMap(new Map([['wos_7', { id: 'emoji7', name: 'wos_7' }]]), [
      { objectId: 7, name: 'Goku' },
      { objectId: 8, name: 'Vegeta' },
    ]);
    expect(map.get(7)).toEqual({ id: 'emoji7', name: 'wos_7' });
    expect(map.has(8)).toBe(false);
  });
});

describe('parseHeroDraftCustomId', () => {
  it('parses select skip and page ids', () => {
    expect(parseHeroDraftCustomId('hdraft:sel:abc:2')).toEqual({
      kind: 'sel',
      draftId: 'abc',
      page: 2,
    });
    expect(parseHeroDraftCustomId('hdraft:skip:abc')).toEqual({ kind: 'skip', draftId: 'abc' });
  });
});

describe('buildHeroDraftComponents', () => {
  it('includes skip ban on ban turns and paginates large pools', () => {
    const pool = Array.from({ length: 30 }, (_, i) => ({
      objectId: i + 1,
      name: `Hero ${i + 1}`,
    }));
    const state = emptyHeroDraftState([team(1), team(2)], pool);
    const rows = buildHeroDraftComponents('draft-1', state);
    expect(rows).toHaveLength(2);
    const select = rows[0]!.components[0]!;
    expect(select.toJSON()).toMatchObject({ type: 3 });
    expect(rows[1]!.components[0]!.toJSON()).toMatchObject({ label: 'Skip ban' });
  });
});
