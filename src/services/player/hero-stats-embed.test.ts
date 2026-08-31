import { MatchResult } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { buildHeroStatsEmbed } from './hero-stats-embed.js';

describe('buildHeroStatsEmbed', () => {
  it('includes Last 20 and Overall fields for league view', () => {
    const embed = buildHeroStatsEmbed({
      heroDisplayName: 'Frieren',
      recentGames: [],
      windows: {
        last20: {
          games: 20,
          avgDamage: 5000,
          avgTaken: 3000,
          avgHeal: 200,
          kda: '2.5',
          topPlayers: [{ username: 'Tiny', games: 5, wins: 4, losses: 1, winRatePercent: 80 }],
        },
        overall: {
          games: 50,
          avgDamage: 4800,
          avgTaken: 2900,
          avgHeal: 180,
          kda: '2.3',
          topPlayers: [],
        },
      },
    });

    const fields = embed.toJSON().fields ?? [];
    expect(fields.some((field) => field.name === 'Last 20 games')).toBe(true);
    expect(fields.some((field) => field.name === 'Overall')).toBe(true);
    expect(embed.toJSON().title).toContain('Frieren');
  });

  it('uses player title when scoped to one player', () => {
    const embed = buildHeroStatsEmbed({
      heroDisplayName: 'Frieren',
      playerUsername: 'Tiny',
      recentGames: [],
      windows: {
        overall: {
          games: 3,
          avgDamage: 100,
          avgTaken: 50,
          avgHeal: 10,
          kda: '1',
          topPlayers: [],
        },
      },
    });
    expect(embed.toJSON().title).toBe('Tiny on Frieren');
  });

  it('includes recent games for league view', () => {
    const embed = buildHeroStatsEmbed({
      heroDisplayName: 'Goku',
      recentGames: [
        {
          matchId: 'match-1',
          username: 'Tiny',
          result: MatchResult.WIN,
          completedAt: new Date('2026-01-15T12:00:00Z'),
        },
      ],
      windows: {
        overall: {
          games: 1,
          avgDamage: 1,
          avgTaken: 1,
          avgHeal: 1,
          kda: '1',
          topPlayers: [],
        },
      },
    });
    const recentField = embed.toJSON().fields?.find((field) => field.name === 'Recent games');
    expect(recentField?.value).toContain('Tiny');
    expect(recentField?.value).toContain('match-1');
  });
});
