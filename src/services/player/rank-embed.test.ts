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
  quits: 2,
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

  it('includes quit count in the record line', () => {
    const description = buildRankEmbed(baseProfile).toJSON().description ?? '';
    expect(description).toContain('12W · 5L · 2Q · 70.6% WR');
  });

  it('omits WR% when no games but still shows quits', () => {
    const embed = buildRankEmbed({
      ...baseProfile,
      discordId: null,
      wins: 0,
      losses: 0,
      quits: 0,
      winRatePercent: null,
    });
    const description = embed.toJSON().description ?? '';
    expect(description).toBe('0W · 0L · 0Q');
    expect(description).not.toContain('WR');
  });

  it('puts a Discord mention in the description when linked', () => {
    const data = buildRankEmbed(baseProfile).toJSON();
    expect(data.description).toContain('Linked · <@d1>');
    expect(data.footer).toBeUndefined();
  });

  it('uses a plain footer when not linked', () => {
    const data = buildRankEmbed({ ...baseProfile, discordId: null }).toJSON();
    expect(data.description).not.toContain('Linked');
    expect(data.footer?.text).toBe('Not linked to Discord');
  });

  it('omits the Heroes field when the player has no hero ratings', () => {
    const data = buildRankEmbed({ ...baseProfile, heroes: [] }).toJSON();
    expect(data.fields ?? []).toEqual([]);
  });

  it('includes the Heroes field when hero ratings exist', () => {
    const data = buildRankEmbed(baseProfile).toJSON();
    expect(data.fields?.[0]?.name).toBe('Heroes');
    expect(data.fields?.[0]?.value).toContain('Goku');
  });
});
