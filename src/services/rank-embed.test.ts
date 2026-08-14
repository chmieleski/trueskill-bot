import { describe, expect, it } from 'vitest';
import { buildRankEmbed, formatHeroTable } from './rank-embed.js';
import type { PlayerProfile } from './player-profile.js';

const baseProfile: PlayerProfile = {
  playerId: 'p1',
  username: 'Tinys',
  discordId: 'd1',
  globalKi: 4000,
  rankPosition: 3,
  wins: 12,
  losses: 5,
  winRatePercent: 70.6,
  heroes: [
    { heroId: 1, name: 'Goku', ki: 4200, matchesPlayed: 8 },
    { heroId: 2, name: 'Vegeta', ki: 3900, matchesPlayed: 4 },
  ],
};

describe('formatHeroTable', () => {
  it('aligns names and shows ki · matches', () => {
    const table = formatHeroTable(baseProfile.heroes);
    expect(table).toContain('Goku');
    expect(table).toContain('4200');
    expect(table).toContain('· 8');
  });

  it('returns italic empty copy when no heroes', () => {
    expect(formatHeroTable([])).toBe('_No hero games yet_');
  });
});

describe('buildRankEmbed', () => {
  it('uses gold accent and rank title', () => {
    const embed = buildRankEmbed(baseProfile, { avatarUrl: 'https://cdn.example/a.png' });
    const data = embed.toJSON();
    expect(data.color).toBe(0xf0b232);
    expect(data.title).toBe('Rank #3 · 4000 ki');
    expect(data.author?.name).toBe('Tinys');
    expect(data.thumbnail?.url).toBe('https://cdn.example/a.png');
  });

  it('omits WR% when no games', () => {
    const embed = buildRankEmbed({
      ...baseProfile,
      wins: 0,
      losses: 0,
      winRatePercent: null,
    });
    const description = embed.toJSON().description ?? '';
    expect(description).toBe('0W · 0L');
    expect(description).not.toContain('WR');
  });
});
