import { describe, expect, it } from 'vitest';
import { buildRankEmbed, formatHeroTable } from './rank-embed.js';
import type { PlayerProfile } from './player-profile.js';
import type { TeammateStats } from './teammate-stats.js';

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
    {
      heroId: 1,
      name: 'Goku',
      ki: 4200,
      matchesPlayed: 8,
      wins: 5,
      losses: 3,
      winRatePercent: 62.5,
    },
    {
      heroId: 2,
      name: 'Vegeta',
      ki: 3900,
      matchesPlayed: 4,
      wins: 2,
      losses: 2,
      winRatePercent: 50,
    },
  ],
};

const sampleTeammates: TeammateStats = {
  playedWith: [
    {
      playerId: 'p2',
      username: 'Ghost',
      games: 14,
      wins: 9,
      losses: 5,
      winRatePercent: 64.3,
    },
  ],
  winWith: [
    {
      playerId: 'p2',
      username: 'Ghost',
      games: 14,
      wins: 9,
      losses: 5,
      winRatePercent: 64.3,
    },
  ],
  loseWith: [],
};

describe('formatHeroTable', () => {
  it('aligns names and shows ki · W-L · WR', () => {
    const table = formatHeroTable(baseProfile.heroes, 17);
    expect(table).toContain('Goku');
    expect(table).toContain('4200');
    expect(table).toContain('5W 3L · 62.5%');
    expect(table).not.toContain('· 8');
  });

  it('omits percent when the hero has no counted games', () => {
    const table = formatHeroTable(
      [
        {
          heroId: 1,
          name: 'Goku',
          ki: 4200,
          matchesPlayed: 8,
          wins: 0,
          losses: 0,
          winRatePercent: null,
        },
      ],
      17,
    );
    expect(table).toContain('0W 0L');
    expect(table).not.toContain('%');
  });

  it('returns italic empty copy when no heroes', () => {
    expect(formatHeroTable([], 17)).toBe('_No hero games yet_');
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

  it('uses profile ratingLabel in the title when provided', () => {
    const data = buildRankEmbed(baseProfile, { ratingLabel: 'power' }).toJSON();
    expect(data.title).toBe('Rank #3 · 4000 power');
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

  it('omits the Heroes field when showHeroes is false even if ratings exist', () => {
    const data = buildRankEmbed(baseProfile, { showHeroes: false }).toJSON();
    expect(data.fields ?? []).toEqual([]);
  });

  it('includes the Heroes field when hero ratings exist', () => {
    const data = buildRankEmbed(baseProfile).toJSON();
    expect(data.fields?.[0]?.name).toBe('Heroes');
    expect(data.fields?.[0]?.value).toContain('Goku');
  });

  it('uses Calibrating title and hero cells when under 5 games', () => {
    const embed = buildRankEmbed({
      ...baseProfile,
      globalKi: 1450,
      rankPosition: null,
      wins: 2,
      losses: 1,
      quits: 0,
      winRatePercent: 66.7,
      heroes: [
        {
          heroId: 1,
          name: 'Goku',
          ki: 4200,
          matchesPlayed: 2,
          wins: 2,
          losses: 1,
          winRatePercent: 66.7,
        },
      ],
    });
    const data = embed.toJSON();
    expect(data.title).toBe('Calibrating');
    expect(data.title).not.toContain('1450');
    expect(data.fields?.[0]?.value).toContain('Calibrating');
    expect(data.fields?.[0]?.value).not.toContain('4200');
    expect(data.fields?.[0]?.value).toContain('2W 1L · 66.7%');
  });

  it('adds teammate fields after Heroes and omits empty lists', () => {
    const data = buildRankEmbed(baseProfile, { teammates: sampleTeammates }).toJSON();
    const names = (data.fields ?? []).map((f) => f.name);
    expect(names).toEqual(['Heroes', 'Played with', 'Win with']);
    expect(data.fields?.[1]?.value).toContain('Ghost');
    expect(data.fields?.[1]?.value).toContain('14G');
    expect(names).not.toContain('Lose with');
  });

  it('still shows teammate fields when Heroes are hidden', () => {
    const data = buildRankEmbed(baseProfile, {
      showHeroes: false,
      teammates: sampleTeammates,
    }).toJSON();
    const names = (data.fields ?? []).map((f) => f.name);
    expect(names).toEqual(['Played with', 'Win with']);
  });

  it('omits all teammate fields when every list is empty', () => {
    const data = buildRankEmbed(baseProfile, {
      teammates: { playedWith: [], winWith: [], loseWith: [] },
    }).toJSON();
    expect((data.fields ?? []).map((f) => f.name)).toEqual(['Heroes']);
  });
});
