import { describe, expect, it } from 'vitest';
import { buildHeroAllEmbed } from './hero-all-embed.js';

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
