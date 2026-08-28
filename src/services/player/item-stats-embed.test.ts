import { describe, expect, it } from 'vitest';
import { buildItemStatsEmbed } from './item-stats-embed.js';

describe('buildItemStatsEmbed', () => {
  it('includes item rows per window', () => {
    const embed = buildItemStatsEmbed({
      windows: {
        overall: [
          {
            objectId: 1,
            displayName: 'Oken',
            buyRatePercent: 38,
            winRatePercent: 55,
            gamesWithItem: 24,
          },
        ],
      },
    });

    const fields = embed.toJSON().fields ?? [];
    expect(fields[0]?.value).toContain('Oken');
    expect(fields[0]?.value).toContain('38% buy');
  });
});
