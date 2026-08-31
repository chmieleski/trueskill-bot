import { describe, expect, it } from 'vitest';
import { buildHeroPlayersEmbed } from './hero-players-embed.js';

describe('buildHeroPlayersEmbed', () => {
  it('formats ranked players with sort label', () => {
    const embed = buildHeroPlayersEmbed(
      {
        heroDisplayName: 'Goku',
        sort: 'damage',
        windows: {
          overall: [
            {
              username: 'Tiny',
              games: 5,
              wins: 4,
              losses: 1,
              winRatePercent: 80,
              avgDamage: 42000,
              kda: '3',
            },
          ],
        },
      },
      { leagueName: 'Test League' },
    );

    expect(embed.toJSON().title).toContain('Avg damage');
    expect(embed.toJSON().description).toBe('Test League');
    expect(embed.toJSON().fields?.[0]?.value).toContain('Tiny');
    expect(embed.toJSON().fields?.[0]?.value).toContain('42k dmg');
  });
});
