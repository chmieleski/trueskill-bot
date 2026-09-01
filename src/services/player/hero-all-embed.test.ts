import { describe, expect, it } from 'vitest';
import {
  buildHeroAllEmbed,
  buildHeroAllPageButtons,
  buildHeroAllPageCustomId,
  decodeHeroAllWindowsToken,
  encodeHeroAllWindowsToken,
  parseHeroAllPageCustomId,
} from './hero-all-embed.js';

const LEAGUE_ID = 'e5863052-d453-48db-b67a-14d1175c298b';
const INVOKER_ID = '123456789012345678';

describe('buildHeroAllEmbed', () => {
  it('renders paginated table for both windows', () => {
    const embed = buildHeroAllEmbed(
      {
        sort: 'win_rate',
        page: 1,
        totalPages: 2,
        totalHeroes: 20,
        windows: {
          last20: [
            {
              heroDisplayName: 'Raiden Ei',
              games: 12,
              wins: 8,
              losses: 4,
              winRatePercent: 66.7,
              avgDamage: 18000,
              avgTaken: 9000,
              avgHeal: 500,
            },
          ],
          overall: [],
        },
      },
      { leagueName: 'WOS IHL' },
    );
    const json = embed.toJSON();
    expect(json.title).toContain('Win rate');
    expect(json.description).toContain('WOS IHL');
    expect(json.fields?.[0]?.name).toBe('Last 20 games');
    expect(json.fields?.[0]?.value).toContain('Raiden Ei');
  });
});

describe('hero all pagination custom ids', () => {
  it('round-trips prev/next and stays under 100 chars', () => {
    const next = buildHeroAllPageCustomId({
      invokerId: INVOKER_ID,
      leagueId: LEAGUE_ID,
      direction: 'next',
      currentPage: 1,
      sort: 'damage',
      windows: ['last20', 'overall'],
    });
    expect(next.length).toBeLessThanOrEqual(100);
    expect(parseHeroAllPageCustomId(next)).toEqual({
      invokerId: INVOKER_ID,
      leagueId: LEAGUE_ID,
      page: 2,
      sort: 'damage',
      windows: ['last20', 'overall'],
    });

    const prev = buildHeroAllPageCustomId({
      invokerId: INVOKER_ID,
      leagueId: LEAGUE_ID,
      direction: 'prev',
      currentPage: 2,
      sort: 'damage',
      windows: ['last20'],
    });
    expect(parseHeroAllPageCustomId(prev)).toEqual({
      invokerId: INVOKER_ID,
      leagueId: LEAGUE_ID,
      page: 1,
      sort: 'damage',
      windows: ['last20'],
    });
  });

  it('encodes and decodes window tokens', () => {
    expect(encodeHeroAllWindowsToken(['last20', 'overall'])).toBe('b');
    expect(encodeHeroAllWindowsToken(['last20'])).toBe('l');
    expect(encodeHeroAllWindowsToken(['overall'])).toBe('o');
    expect(decodeHeroAllWindowsToken('b')).toEqual(['last20', 'overall']);
    expect(decodeHeroAllWindowsToken('l')).toEqual(['last20']);
    expect(decodeHeroAllWindowsToken('o')).toEqual(['overall']);
  });
});

describe('buildHeroAllPageButtons', () => {
  it('returns no rows on a single page', () => {
    expect(
      buildHeroAllPageButtons({
        invokerId: INVOKER_ID,
        leagueId: LEAGUE_ID,
        page: 1,
        totalPages: 1,
        sort: 'win_rate',
        windows: ['last20', 'overall'],
      }),
    ).toEqual([]);
  });

  it('enables next on the first page of a multi-page list', () => {
    const rows = buildHeroAllPageButtons({
      invokerId: INVOKER_ID,
      leagueId: LEAGUE_ID,
      page: 1,
      totalPages: 2,
      sort: 'games',
      windows: ['overall'],
    });
    expect(rows).toHaveLength(1);
    const buttons = rows[0]!.components;
    expect(buttons[0]?.data.disabled).toBe(true);
    expect(buttons[1]?.data.disabled).toBe(false);
  });
});
