import { describe, expect, it } from 'vitest';
import { buildItemStatsEmbed, formatItemStatsTable } from './item-stats-embed.js';

describe('formatItemStatsTable', () => {
  it('renders buy rate, win rate, and picks in columns', () => {
    const table = formatItemStatsTable([
      {
        objectId: 1,
        displayName: 'Prison Realm (Active)',
        buyRatePercent: 50,
        winRatePercent: 60,
        gamesWithItem: 5,
      },
    ]);

    expect(table).toContain('```');
    expect(table).toContain('Prison Realm (Active)');
    expect(table).toContain('50%');
    expect(table).toContain('60%');
    expect(table).toContain('5');
  });
});

describe('buildItemStatsEmbed', () => {
  it('includes item rows per window', () => {
    const embed = buildItemStatsEmbed({
      sort: 'buy_rate',
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
    expect(fields[0]?.value).toContain('```');
    expect(fields[0]?.value).toContain('Oken');
    expect(fields[0]?.value).toContain('38%');
    expect(fields[0]?.value).toContain('55%');
  });
});
