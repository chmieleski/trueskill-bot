import { describe, expect, it } from 'vitest';
import {
  buildAllHeroLeaderboardsEmbed,
  buildHeroLeaderboardEmbed,
  buildLeaderboardPageButtons,
  buildOverallLeaderboardEmbed,
  buildOverallLiveLeaderboardEmbeds,
  formatOverallTable,
  formatRankPrefix,
  parseLeaderboardPageCustomId,
} from './leaderboard-embed.js';
import type { OverallLeaderboardEntry } from './leaderboard.js';

function fakeEntry(rank: number): OverallLeaderboardEntry {
  return {
    rank,
    playerId: `p${rank}`,
    username: `Player${rank}`,
    ki: 1000 + rank,
    games: 10,
    leagueGames: 10,
    discordId: null,
    winRatePercent: 50,
  };
}

describe('formatRankPrefix', () => {
  it('uses medals for top 3', () => {
    expect(formatRankPrefix(1)).toBe('🥇');
    expect(formatRankPrefix(2)).toBe('🥈');
    expect(formatRankPrefix(3)).toBe('🥉');
    expect(formatRankPrefix(4)).toBe('#4');
  });

  it('uses an em dash when unranked', () => {
    expect(formatRankPrefix(null)).toBe('—');
  });
});

describe('formatOverallTable', () => {
  it('uses a capitalized ratingLabel column header', () => {
    const table = formatOverallTable([fakeEntry(1)], 'power');
    expect(table).toContain('Power');
    expect(table).not.toContain(' Ki');
  });

  it('prints Calibrating instead of ki when leagueGames < 5', () => {
    const table = formatOverallTable([
      {
        rank: 1,
        playerId: 'p1',
        username: 'Vet',
        ki: 4820,
        games: 20,
        leagueGames: 20,
        discordId: null,
        winRatePercent: 50,
      },
      {
        rank: null,
        playerId: 'p2',
        username: 'Rookie',
        ki: 9000,
        games: 2,
        leagueGames: 2,
        discordId: null,
        winRatePercent: 50,
      },
    ]);
    expect(table).toContain('4820');
    expect(table).toContain('Calibrating');
    expect(table).not.toContain('9000');
    expect(table).toContain('—');
  });

  it('adds a WR column', () => {
    const table = formatOverallTable([
      {
        rank: 1,
        playerId: 'p1',
        username: 'Tinys',
        ki: 4200,
        games: 17,
        leagueGames: 17,
        discordId: null,
        winRatePercent: 70.6,
      },
    ]);
    expect(table).toContain('WR');
    expect(table).toContain('70.6%');
  });

  it('prints an em dash when winRatePercent is null', () => {
    const table = formatOverallTable([
      {
        rank: 1,
        playerId: 'p1',
        username: 'Tinys',
        ki: 4200,
        games: 8,
        leagueGames: 8,
        discordId: null,
        winRatePercent: null,
      },
    ]);
    expect(table).toMatch(/WR/);
    expect(table).toContain('—');
  });

  it('gives gold to first eligible when #1 is locked out', () => {
    const entries = [
      { ...fakeEntry(1), prizeEligible: false, medalRank: null },
      { ...fakeEntry(2), prizeEligible: true, medalRank: 1 },
      { ...fakeEntry(3), prizeEligible: true, medalRank: 2 },
    ];
    const table = formatOverallTable(entries, 'ki', { prizeLockActive: true });
    expect(table).toContain('#1');
    expect(table).toContain('🥇');
    expect(table.indexOf('#1')).toBeLessThan(table.indexOf('🥇'));
  });

  it('keeps board-rank medals when prize lock is inactive', () => {
    const table = formatOverallTable([fakeEntry(1), fakeEntry(2), fakeEntry(3)], 'ki', {
      prizeLockActive: false,
    });
    expect(table).toContain('🥇');
    expect(table).toContain('🥈');
    expect(table).toContain('🥉');
    expect(table).not.toContain('#1');
  });
});

describe('prize lock embed copy', () => {
  it('adds footnote on command embed when prize lock is active', () => {
    const embed = buildOverallLeaderboardEmbed({
      entries: [{ ...fakeEntry(1), prizeEligible: true, medalRank: 1 }],
      page: 1,
      totalPages: 1,
      totalPlayers: 1,
      prizeLockActive: true,
    });
    expect(embed.data.description).toContain(
      'Medals require a completed game on each day of the season crunch week.',
    );
  });

  it('adds crunch banner and footnote on live embeds when prize lock is active', () => {
    const updatedAt = new Date('2026-08-15T12:00:00Z');
    const embeds = buildOverallLiveLeaderboardEmbeds(
      [{ ...fakeEntry(1), prizeEligible: true, medalRank: 1 }],
      updatedAt,
      'ki',
      { prizeLockActive: true },
    );
    expect(embeds[0]!.data.description).toContain(
      'Season crunch — play this week to keep your medal spot.',
    );
    expect(embeds[0]!.data.description).toContain(
      'Medals require a completed game on each day of the season crunch week.',
    );
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
          leagueGames: 42,
          discordId: null,
          winRatePercent: 50,
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

  it('passes ratingLabel into the table header', () => {
    const embed = buildOverallLeaderboardEmbed(
      {
        entries: [fakeEntry(1)],
        page: 1,
        totalPages: 1,
        totalPlayers: 1,
      },
      { ratingLabel: 'power' },
    );
    expect(embed.data.description).toContain('Power');
  });

  it('omits page line for live mode and renders timestamp in description', () => {
    const updatedAt = new Date('2026-08-14T10:00:00Z');
    const embed = buildOverallLeaderboardEmbed(
      { entries: [], page: 1, totalPages: 1, totalPlayers: 0 },
      { live: true, updatedAt },
    );
    const unix = Math.floor(updatedAt.getTime() / 1000);
    expect(embed.data.description).not.toContain('Page');
    expect(embed.data.description).toContain(`Updated <t:${unix}:R>`);
    expect(embed.data.footer).toBeUndefined();
  });
});

describe('buildHeroLeaderboardEmbed', () => {
  it('shows empty copy when no entries', () => {
    const embed = buildHeroLeaderboardEmbed('Goku', []);
    expect(embed.data.description).toBe('_No games yet for Goku._');
  });

  it('prints Calibrating using leagueGames, not hero matchesPlayed', () => {
    const embed = buildHeroLeaderboardEmbed('Goku', [
      {
        rank: null,
        playerId: 'p1',
        username: 'Rookie',
        ki: 4200,
        matchesPlayed: 3,
        leagueGames: 2,
        winRatePercent: 0,
      },
    ]);
    expect(embed.data.description).toContain('Calibrating');
    expect(embed.data.description).not.toContain('4200');
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
            leagueGames: 8,
            winRatePercent: 62.5,
          },
        ],
      },
    ]);
    expect(embed.data.fields).toHaveLength(1);
    expect(embed.data.fields?.[0]?.name).toBe('Goku');
    expect(embed.data.fields?.[0]?.value).toContain('Tinys');
    expect(embed.data.fields?.[0]?.value).toContain('4200');
    expect(embed.data.fields?.[0]?.value).not.toContain('WR');
    expect(embed.data.fields?.[0]?.value).not.toContain('62.5%');
  });
});

describe('buildLeaderboardPageButtons', () => {
  it('shows disabled prev/next on a single-page leaderboard', () => {
    const rows = buildLeaderboardPageButtons({
      invokerId: 'user1',
      leagueId: 'league-1',
      page: 1,
      totalPages: 1,
    });
    expect(rows).toHaveLength(1);
    const buttons = rows[0]!.components;
    expect(buttons[0]?.data.disabled).toBe(true);
    expect(buttons[1]?.data.disabled).toBe(true);
    expect(buttons[0]?.data.custom_id).not.toBe(buttons[1]?.data.custom_id);
  });
});

describe('buildOverallLiveLeaderboardEmbeds', () => {
  const updatedAt = new Date('2026-08-15T12:00:00Z');
  const unix = Math.floor(updatedAt.getTime() / 1000);

  it('returns one embed for empty ladder with timestamp', () => {
    const embeds = buildOverallLiveLeaderboardEmbeds([], updatedAt);
    expect(embeds).toHaveLength(1);
    expect(embeds[0]!.data.title).toBe('Global Leaderboard');
    expect(embeds[0]!.data.description).toContain('No ranked players yet');
    expect(embeds[0]!.data.description).toContain(`Updated <t:${unix}:R>`);
  });

  it('returns one embed for 25 or fewer entries', () => {
    const embeds = buildOverallLiveLeaderboardEmbeds(
      Array.from({ length: 10 }, (_, i) => fakeEntry(i + 1)),
      updatedAt,
    );
    expect(embeds).toHaveLength(1);
    expect(embeds[0]!.data.title).toBe('Global Leaderboard');
    expect(embeds[0]!.data.description).toContain(`Updated <t:${unix}:R>`);
  });

  it('splits at 26 into two embeds; timestamp only on last', () => {
    const embeds = buildOverallLiveLeaderboardEmbeds(
      Array.from({ length: 26 }, (_, i) => fakeEntry(i + 1)),
      updatedAt,
    );
    expect(embeds).toHaveLength(2);
    expect(embeds[0]!.data.title).toBe('Global Leaderboard');
    expect(embeds[1]!.data.title).toBe('Global Leaderboard (continued)');
    expect(embeds[0]!.data.description).not.toContain('Updated <t:');
    expect(embeds[1]!.data.description).toContain(`Updated <t:${unix}:R>`);
  });

  it('uses four embeds for 100 entries', () => {
    const embeds = buildOverallLiveLeaderboardEmbeds(
      Array.from({ length: 100 }, (_, i) => fakeEntry(i + 1)),
      updatedAt,
    );
    expect(embeds).toHaveLength(4);
    expect(embeds[3]!.data.description).toContain(`Updated <t:${unix}:R>`);
  });
});

describe('parseLeaderboardPageCustomId', () => {
  it('parses prev and next ids into target pages', () => {
    expect(parseLeaderboardPageCustomId('leaderboard:page:user1:prev:2:league-1')).toEqual({
      invokerId: 'user1',
      page: 1,
      leagueId: 'league-1',
    });
    expect(parseLeaderboardPageCustomId('leaderboard:page:user1:next:2:league-1')).toEqual({
      invokerId: 'user1',
      page: 3,
      leagueId: 'league-1',
    });
  });

  it('returns null for invalid id', () => {
    expect(parseLeaderboardPageCustomId('lobby:start')).toBeNull();
  });
});
