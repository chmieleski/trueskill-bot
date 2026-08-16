import { describe, expect, it } from 'vitest';
import {
  buildQuitterLiveLeaderboardEmbeds,
  buildQuitterLeaderboardEmbed,
  formatQuitRate,
  formatQuitterTable,
  parseQuitterPageCustomId,
} from './quitter-leaderboard-embed.js';
import type { QuitterLeaderboardEntry } from './quitter-leaderboard.js';

function entry(
  partial: Partial<QuitterLeaderboardEntry> & Pick<QuitterLeaderboardEntry, 'rank' | 'username'>,
): QuitterLeaderboardEntry {
  return {
    playerId: partial.playerId ?? 'p',
    discordId: null,
    quitCount: partial.quitCount ?? 1,
    completedCount: partial.completedCount ?? 4,
    rate: partial.rate ?? 0.25,
    ...partial,
  };
}

describe('formatQuitRate', () => {
  it('formats one decimal percent', () => {
    expect(formatQuitRate(0.125)).toBe('12.5%');
    expect(formatQuitRate(1)).toBe('100.0%');
  });
});

describe('formatQuitterTable', () => {
  it('omits columns by display mode', () => {
    const rows = [
      entry({ rank: 1, username: 'Goku', quitCount: 3, completedCount: 10, rate: 0.3 }),
    ];
    expect(formatQuitterTable(rows, 'count')).toContain('Quits');
    expect(formatQuitterTable(rows, 'count')).not.toContain('Rate');
    expect(formatQuitterTable(rows, 'rate')).toContain('Rate');
    expect(formatQuitterTable(rows, 'rate')).not.toContain('Quits');
    expect(formatQuitterTable(rows, 'both')).toContain('Quits');
    expect(formatQuitterTable(rows, 'both')).toContain('Rate');
  });

  it('empty copy depends on sort via caller empty strings', () => {
    expect(formatQuitterTable([], 'both')).toBe('_No quitters recorded yet._');
  });
});

describe('buildQuitterLeaderboardEmbed', () => {
  it('includes page header and sort footer', () => {
    const embed = buildQuitterLeaderboardEmbed({
      entries: [entry({ rank: 1, username: 'Goku' })],
      page: 1,
      totalPages: 1,
      totalPlayers: 1,
      display: 'both',
      sort: 'rate',
    });
    expect(embed.data.title).toBe('Quitter Leaderboard');
    expect(embed.data.footer?.text).toMatch(/Sorted by rate/i);
  });
});

describe('buildQuitterLiveLeaderboardEmbeds', () => {
  it('chunks and stamps last embed', () => {
    const entries = Array.from({ length: 26 }, (_, i) =>
      entry({ rank: i + 1, username: `u${i}`, quitCount: 26 - i }),
    );
    const embeds = buildQuitterLiveLeaderboardEmbeds(
      entries,
      'count',
      'count',
      new Date('2026-08-16T00:00:00Z'),
    );
    expect(embeds).toHaveLength(2);
    expect(embeds[0]!.data.title).toBe('Quitter Leaderboard');
    expect(embeds[1]!.data.title).toBe('Quitter Leaderboard (continued)');
    expect(embeds[1]!.data.description).toMatch(/Updated <t:/);
    expect(embeds[0]!.data.description).not.toMatch(/Updated <t:/);
  });
});

describe('parseQuitterPageCustomId', () => {
  it('parses prev/next', () => {
    expect(parseQuitterPageCustomId('lb:quitters:page:9:next:2')).toEqual({
      invokerId: '9',
      page: 3,
    });
    expect(parseQuitterPageCustomId('leaderboard:page:9:next:2:league')).toBeNull();
  });
});
