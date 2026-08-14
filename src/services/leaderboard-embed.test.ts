import { describe, expect, it } from 'vitest';
import {
  buildAllHeroLeaderboardsEmbed,
  buildHeroLeaderboardEmbed,
  buildOverallLeaderboardEmbed,
  formatRankPrefix,
  parseLeaderboardPageCustomId,
} from './leaderboard-embed.js';

describe('formatRankPrefix', () => {
  it('uses medals for top 3', () => {
    expect(formatRankPrefix(1)).toBe('🥇');
    expect(formatRankPrefix(2)).toBe('🥈');
    expect(formatRankPrefix(3)).toBe('🥉');
    expect(formatRankPrefix(4)).toBe('#4');
  });
});

describe('buildOverallLeaderboardEmbed', () => {
  it('includes page line for command mode', () => {
    const embed = buildOverallLeaderboardEmbed({
      entries: [
        {
          rank: 1,
          playerId: 'p1',
          username: 'Tinys',
          ki: 4820,
          games: 42,
          discordId: null,
        },
      ],
      page: 1,
      totalPages: 1,
      totalPlayers: 1,
    });
    const data = embed.data;
    expect(data.title).toBe('Global Leaderboard');
    expect(data.color).toBe(0xf0b232);
    expect(data.description).toContain('Page 1 of 1');
    expect(data.description).toContain('Tinys');
  });

  it('omits page line for live mode', () => {
    const embed = buildOverallLeaderboardEmbed(
      { entries: [], page: 1, totalPages: 1, totalPlayers: 0 },
      { live: true, updatedAt: new Date('2026-08-14T10:00:00Z') },
    );
    expect(embed.data.description).not.toContain('Page');
    expect(embed.data.footer?.text).toContain('Updated');
  });
});

describe('buildHeroLeaderboardEmbed', () => {
  it('shows empty copy when no entries', () => {
    const embed = buildHeroLeaderboardEmbed('Goku', []);
    expect(embed.data.description).toBe('_No games yet for Goku._');
  });
});

describe('buildAllHeroLeaderboardsEmbed', () => {
  it('adds one field per hero slice', () => {
    const embed = buildAllHeroLeaderboardsEmbed([
      {
        heroId: 1,
        heroName: 'Goku',
        entries: [
          {
            rank: 1,
            playerId: 'p1',
            username: 'Tinys',
            ki: 4200,
            matchesPlayed: 8,
          },
        ],
      },
    ]);
    expect(embed.data.fields).toHaveLength(1);
    expect(embed.data.fields?.[0]?.name).toBe('Goku');
  });
});

describe('parseLeaderboardPageCustomId', () => {
  it('parses valid custom id', () => {
    expect(parseLeaderboardPageCustomId('leaderboard:page:user1:2')).toEqual({
      invokerId: 'user1',
      page: 2,
    });
  });

  it('returns null for invalid id', () => {
    expect(parseLeaderboardPageCustomId('lobby:start')).toBeNull();
  });
});
