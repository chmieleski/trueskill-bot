import { describe, expect, it } from 'vitest';
import { applyBan, applyPick, applySkipBan } from './draft-logic.js';
import {
  buildHeroDraftActionLogContent,
  buildHeroDraftComponents,
  buildHeroDraftEmbed,
  filterAvailableHeroesForAutocomplete,
  formatHeroLabel,
  heroApplicationEmojiName,
  parseHeroDraftCustomId,
  resolveHeroEmojiMap,
  truncateEmbedField,
} from './draft-ui.js';
import { emptyHeroDraftState, type HeroDraftTeam } from './draft-types.js';

const team = (side: 1 | 2, name?: string): HeroDraftTeam => ({
  side,
  displayName: name ?? `Team ${side}`,
  captain: { key: `c${side}`, label: `C${side}`, discordId: `d${side}` },
  roster: [{ key: `c${side}`, label: `C${side}`, discordId: `d${side}` }],
  bans: [],
  picks: [],
});

const pool = [
  { objectId: 1, name: 'Goku' },
  { objectId: 2, name: 'Vegeta' },
  { objectId: 3, name: 'Piccolo' },
  { objectId: 4, name: 'Frieza' },
  { objectId: 5, name: 'Cell' },
  { objectId: 6, name: 'Gohan' },
  { objectId: 7, name: 'Trunks' },
  { objectId: 8, name: 'Krillin' },
  { objectId: 9, name: 'Tien' },
  { objectId: 10, name: 'Yamcha' },
  { objectId: 11, name: 'Buu' },
  { objectId: 12, name: 'Broly' },
  { objectId: 13, name: 'Hit' },
  { objectId: 14, name: 'Jiren' },
  { objectId: 15, name: 'Toppo' },
  { objectId: 16, name: 'Dyspo' },
];

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
    const largePool = Array.from({ length: 30 }, (_, i) => ({
      objectId: i + 1,
      name: `Hero ${i + 1}`,
    }));
    const state = emptyHeroDraftState([team(1), team(2)], largePool);
    const rows = buildHeroDraftComponents('draft-1', state);
    expect(rows).toHaveLength(2);
    const select = rows[0]!.components[0]!;
    expect(select.toJSON()).toMatchObject({ type: 3, placeholder: '🚫 Ban a hero (page 1/2)' });
    expect(rows[1]!.components[0]!.toJSON()).toMatchObject({ label: 'Skip ban' });
  });

  it('keeps Next page within the Discord 25-option select limit', () => {
    const largePool = Array.from({ length: 40 }, (_, i) => ({
      objectId: i + 1,
      name: `Hero ${i + 1}`,
    }));
    const state = emptyHeroDraftState([team(1), team(2)], largePool);
    const select = buildHeroDraftComponents('draft-1', state)[0]!.components[0]!.toJSON() as {
      options: Array<{ label: string; value: string }>;
    };
    expect(select.options.length).toBeLessThanOrEqual(25);
    expect(select.options.some((o) => o.label === 'Next page →')).toBe(true);
    expect(select.options.some((o) => o.value.startsWith('__page__:'))).toBe(true);
  });

  it('keeps Previous and Next page on middle pages without dropping heroes past the cap', () => {
    const largePool = Array.from({ length: 60 }, (_, i) => ({
      objectId: i + 1,
      name: `Hero ${i + 1}`,
    }));
    const state = { ...emptyHeroDraftState([team(1), team(2)], largePool), selectPage: 1 };
    const select = buildHeroDraftComponents('draft-1', state)[0]!.components[0]!.toJSON() as {
      options: Array<{ label: string; value: string }>;
    };
    expect(select.options.length).toBeLessThanOrEqual(25);
    expect(select.options[0]?.label).toBe('← Previous page');
    expect(select.options.at(-1)?.label).toBe('Next page →');
    const heroOptions = select.options.filter((o) => !o.value.startsWith('__page__:'));
    expect(heroOptions.length).toBeGreaterThan(0);
    expect(heroOptions.length + 2).toBe(select.options.length);
  });
});

describe('buildHeroDraftEmbed', () => {
  it('uses dual-column team fields with ban/pick emoji headers', () => {
    let state = emptyHeroDraftState([team(1, 'Alpha'), team(2, 'Bravo')], pool);
    state = applyBan(state, 3);
    const emojiMap = new Map([[3, { id: 'e3', name: 'wos_3' }]]);
    const embed = buildHeroDraftEmbed(state, emojiMap).toJSON();
    expect(embed.description).toMatch(/🚫 \*\*BAN\*\*/);
    expect(embed.fields).toHaveLength(3);
    expect(embed.fields![0]).toMatchObject({ name: 'Alpha', inline: true });
    expect(embed.fields![1]).toMatchObject({ name: 'Bravo', inline: true });
    expect(embed.fields![0]!.value).toContain('🚫 Bans');
    expect(embed.fields![0]!.value).toContain('<:wos_3:e3> Piccolo');
    expect(embed.fields![0]!.value).toContain('✅ Picks');
    expect(embed.fields![2]!.value).toContain('/hero_draft select');
    expect(embed.fields![2]!.value).toMatch(/ban\/pick with search/i);
  });
});

describe('formatHeroLabel', () => {
  it('includes application emoji when mapped', () => {
    const state = emptyHeroDraftState([team(1), team(2)], pool);
    expect(formatHeroLabel(state, 1, new Map([[1, { id: 'eg', name: 'wos_1' }]]))).toBe(
      '<:wos_1:eg> Goku',
    );
    expect(formatHeroLabel(state, 1, new Map())).toBe('Goku');
  });
});

describe('truncateEmbedField', () => {
  it('appends a marker when over the limit', () => {
    const long = 'x'.repeat(1100);
    const truncated = truncateEmbedField(long, 100);
    expect(truncated.length).toBe(100);
    expect(truncated.endsWith('… +more')).toBe(true);
  });
});

describe('buildHeroDraftActionLogContent', () => {
  it('logs a ban and pings the next captain for pick', () => {
    const previous = emptyHeroDraftState([team(1, 'Alpha'), team(2, 'Bravo')], pool);
    const next = applyBan(previous, 1);
    const emojiMap = new Map([[1, { id: 'eg', name: 'wos_1' }]]);
    const log = buildHeroDraftActionLogContent(previous, next, emojiMap);
    expect(log.content).toContain('🚫 **Alpha** banned <:wos_1:eg> Goku');
    expect(log.content).toContain('🚫 **BAN** <@d2>');
    expect(log.mentionUserIds).toEqual(['d2']);
  });

  it('logs skip ban and timeout note', () => {
    const previous = emptyHeroDraftState([team(1, 'Alpha'), team(2, 'Bravo')], pool);
    const next = applySkipBan(previous);
    const log = buildHeroDraftActionLogContent(previous, next, new Map(), { reason: 'timeout' });
    expect(log.content).toContain('skipped ban');
    expect(log.content).toContain('(timeout)');
  });

  it('logs cancel without mentions', () => {
    const state = emptyHeroDraftState([team(1), team(2)], pool);
    const log = buildHeroDraftActionLogContent(state, state, new Map(), { reason: 'cancel' });
    expect(log.content).toContain('cancelled');
    expect(log.mentionUserIds).toEqual([]);
  });

  it('logs pick advancing to next ban', () => {
    let state = emptyHeroDraftState([team(1, 'Alpha'), team(2, 'Bravo')], pool);
    state = applyBan(state, 1);
    state = applyBan(state, 2);
    state = applyBan(state, 3);
    state = applyBan(state, 4);
    const previous = state;
    const next = applyPick(previous, 5);
    const log = buildHeroDraftActionLogContent(previous, next, new Map());
    expect(log.content).toContain('✅ **Alpha** picked Cell');
    expect(log.content).toMatch(/✅ \*\*PICK\*\* <@d2>/);
  });
});

describe('filterAvailableHeroesForAutocomplete', () => {
  it('filters by name substring and respects limit', () => {
    let state = emptyHeroDraftState([team(1), team(2)], pool);
    state = applyBan(state, 1);
    const hits = filterAvailableHeroesForAutocomplete(state, 'go', 25);
    expect(hits.map((h) => h.name)).toEqual(['Gohan']);
    expect(filterAvailableHeroesForAutocomplete(state, 've', 25).map((h) => h.name)).toEqual([
      'Vegeta',
    ]);
    expect(filterAvailableHeroesForAutocomplete(state, '', 2)).toHaveLength(2);
  });
});
