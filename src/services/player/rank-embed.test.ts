import { describe, expect, it } from 'vitest';
import { buildRankEmbed, formatGrieferPoolField, formatHeroTable } from './rank-embed.js';
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
  griefs: 1,
  pendingGrieferKiTax: 250,
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
  decayFooter: null,
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

  it('includes quit and grief counts in the record line', () => {
    const description = buildRankEmbed(baseProfile).toJSON().description ?? '';
    expect(description).toContain('12W · 5L · 2Q · 1G · 70.6% WR');
    expect(description).not.toContain('tax ki');
  });

  it('shows griefer pool field with pending season-end ki loss', () => {
    const fields = buildRankEmbed(baseProfile).toJSON().fields ?? [];
    expect(fields[0]).toMatchObject({
      name: 'Griefer pool',
      value: 'Loses **250 ki** at season end (1 grief)',
    });
  });

  it('omits griefer pool when no pending tax', () => {
    const fields =
      buildRankEmbed({ ...baseProfile, griefs: 0, pendingGrieferKiTax: 0 }).toJSON().fields ?? [];
    expect(fields.find((field) => field.name === 'Griefer pool')).toBeUndefined();
  });

  it('formatGrieferPoolField pluralizes grief count', () => {
    expect(formatGrieferPoolField({ griefs: 2, pendingGrieferKiTax: 400 }, 'ki')).toBe(
      'Loses **400 ki** at season end (2 griefs)',
    );
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
      griefs: 0,
      pendingGrieferKiTax: 0,
      winRatePercent: null,
    });
    const description = embed.toJSON().description ?? '';
    expect(description).toBe('0W · 0L · 0Q · 0G');
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
    const names = buildRankEmbed({ ...baseProfile, heroes: [] })
      .toJSON()
      .fields?.map((f) => f.name);
    expect(names).toEqual(['Griefer pool']);
  });

  it('omits the Heroes field when showHeroes is false even if ratings exist', () => {
    const names = buildRankEmbed(baseProfile, { showHeroes: false })
      .toJSON()
      .fields?.map((f) => f.name);
    expect(names).toEqual(['Griefer pool']);
  });

  it('includes the Heroes field when hero ratings exist', () => {
    const data = buildRankEmbed(baseProfile).toJSON();
    const heroesField = (data.fields ?? []).find((field) => field.name === 'Heroes');
    expect(heroesField?.value).toContain('Goku');
  });

  it('uses Calibrating title and hero cells when under 5 games', () => {
    const embed = buildRankEmbed({
      ...baseProfile,
      globalKi: 1450,
      rankPosition: null,
      wins: 2,
      losses: 1,
      quits: 0,
      griefs: 0,
      pendingGrieferKiTax: 0,
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

  it('adds teammate fields after Griefer pool and Heroes', () => {
    const data = buildRankEmbed(baseProfile, { teammates: sampleTeammates }).toJSON();
    const names = (data.fields ?? []).map((f) => f.name);
    expect(names).toEqual(['Griefer pool', 'Heroes', 'Played with', 'Win with']);
    expect(data.fields?.find((field) => field.name === 'Played with')?.value).toContain('Ghost');
    expect(data.fields?.find((field) => field.name === 'Played with')?.value).toContain('14G');
    expect(names).not.toContain('Lose with');
  });

  it('still shows teammate fields when Heroes are hidden', () => {
    const data = buildRankEmbed(baseProfile, {
      showHeroes: false,
      teammates: sampleTeammates,
    }).toJSON();
    const names = (data.fields ?? []).map((f) => f.name);
    expect(names).toEqual(['Griefer pool', 'Played with', 'Win with']);
  });

  it('omits all teammate fields when every list is empty', () => {
    const data = buildRankEmbed(baseProfile, {
      teammates: { playedWith: [], winWith: [], loseWith: [] },
    }).toJSON();
    expect((data.fields ?? []).map((f) => f.name)).toEqual(['Griefer pool', 'Heroes']);
  });

  it('shows idle decay footer for linked players when set', () => {
    const data = buildRankEmbed({
      ...baseProfile,
      decayFooter:
        'Inactive 11+ days: league ki decays −50/day (−100/day after 20 days) until you finish a game.',
    }).toJSON();
    expect(data.footer?.text).toContain('Inactive 11+ days');
  });

  it('shows crunch decay footer for linked players when set', () => {
    const data = buildRankEmbed({
      ...baseProfile,
      decayFooter: 'Crunch week: −100 ki/day after 2 idle days (−200/day after 10).',
    }).toJSON();
    expect(data.footer?.text).toContain('Crunch week');
  });

  it('prefers not-linked footer over decay hint', () => {
    const data = buildRankEmbed({
      ...baseProfile,
      discordId: null,
      decayFooter:
        'Inactive 11+ days: league ki decays −50/day (−100/day after 20 days) until you finish a game.',
    }).toJSON();
    expect(data.footer?.text).toBe('Not linked to Discord');
  });
});
