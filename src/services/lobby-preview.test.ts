import { describe, expect, it } from 'vitest';
import {
  buildMatchCompletedEmbed,
  buildMatchInProgressEmbed,
  buildMatchLobbyEmbed,
  buildMatchReportButtons,
  formatSignedDelta,
  formatTeamLinesFromPreview,
} from './lobby-preview.js';
import { buildCompletedRatingPreview } from './rating-preview.js';

describe('formatSignedDelta', () => {
  it('formats signed deltas and omits when undefined', () => {
    expect(formatSignedDelta(undefined)).toBe('');
    expect(formatSignedDelta(186)).toBe(' (+186)');
    expect(formatSignedDelta(-50)).toBe(' (-50)');
    expect(formatSignedDelta(0)).toBe(' (0)');
  });
});

describe('formatTeamLinesFromPreview', () => {
  it('appends the quitter marker outside the code span', () => {
    const value = formatTeamLinesFromPreview([
      { slot: 1, nick: 'goku', globalOrdinal: 1100, heroOrdinal: 2200, isQuitter: true },
      { slot: 7, nick: 'vegeta', globalOrdinal: 3300, heroOrdinal: 4400 },
    ]);
    const [firstLine, secondLine] = value.split('\n');

    expect(firstLine).toContain('`goku');
    expect(firstLine).toContain('🚪');
    expect(firstLine).toMatch(/`\s*goku\s+1100 \/ 2200`\s+🚪$/);
    expect(secondLine).toContain('`vegeta');
    expect(secondLine).not.toContain('🚪');
  });

  it('shows signed ki deltas inline on completed roster lines', () => {
    const value = formatTeamLinesFromPreview([
      {
        slot: 1,
        nick: 'goku',
        globalOrdinal: 1186,
        heroOrdinal: 1200,
        globalDelta: 186,
        heroDelta: 200,
      },
      {
        slot: 7,
        nick: 'vegeta',
        globalOrdinal: 900,
        heroOrdinal: 850,
        globalDelta: -100,
        heroDelta: -150,
        isQuitter: true,
      },
    ]);
    const [firstLine, secondLine] = value.split('\n');

    expect(firstLine).toContain('1186 (+186) / 1200 (+200)');
    expect(secondLine).toContain(' 900 (-100) /  850 (-150)');
    expect(secondLine).toMatch(/`\s+🚪$/);
  });
});

describe('buildCompletedRatingPreview', () => {
  it('attaches after−before ki deltas per player', () => {
    const preview = buildCompletedRatingPreview(
      [
        { playerId: 'p1', slot: 1, heroId: 1, nick: 'goku', isQuitter: false },
        { playerId: 'p2', slot: 7, heroId: 7, nick: 'vegeta', isQuitter: true },
      ],
      new Map([
        [1, { global: 1000, hero: 1000 }],
        [7, { global: 1000, hero: 1000 }],
      ]),
      new Map([
        [1, { global: 1186, hero: 1200 }],
        [7, { global: 900, hero: 850 }],
      ]),
    );

    expect(preview.players).toEqual([
      {
        slot: 1,
        nick: 'goku',
        globalOrdinal: 1186,
        heroOrdinal: 1200,
        globalDelta: 186,
        heroDelta: 200,
        isQuitter: false,
      },
      {
        slot: 7,
        nick: 'vegeta',
        globalOrdinal: 900,
        heroOrdinal: 850,
        globalDelta: -100,
        heroDelta: -150,
        isQuitter: true,
      },
    ]);
  });
});

describe('buildMatchReportButtons', () => {
  it('renders the match report action row', () => {
    const [row] = buildMatchReportButtons();

    expect(row).toBeDefined();
    expect(row?.toJSON().components.map((button) => button.custom_id)).toEqual([
      'match:report',
      'match:quitters',
      'match:cancel',
    ]);
  });
});

describe('balance hint on embeds', () => {
  it('shows Balance hint on Match Lobby when suggestion present', () => {
    const embed = buildMatchLobbyEmbed('m1', [
      { nick: 'Alice', slot: 1 },
      { nick: 'Bob', slot: 7 },
    ], {
      ratingPreview: {
        players: [
          { slot: 1, nick: 'Alice', globalOrdinal: 1000, heroOrdinal: 1000 },
          { slot: 7, nick: 'Bob', globalOrdinal: 1000, heroOrdinal: 1000 },
        ],
        winChance: { teamAPercent: 70, teamBPercent: 30 },
        balanceSuggestion: {
          kind: 'swap',
          fromSlot: 1,
          toSlot: 7,
          fromNick: 'Alice',
          toNick: 'Bob',
          resultingWinChance: { teamAPercent: 52, teamBPercent: 48 },
        },
      },
    });
    const fields = embed.data.fields ?? [];
    const hint = fields.find((f) => f.name === 'Balance hint');
    expect(hint?.value).toBe('Swap Alice (1) ↔ Bob (7) → ~52% / 48%');
  });

  it('omits Balance hint on Match In Progress even if DTO has suggestion', () => {
    const embed = buildMatchInProgressEmbed('m1', [
      { nick: 'Alice', slot: 1 },
      { nick: 'Bob', slot: 7 },
    ], {
      ratingPreview: {
        players: [
          { slot: 1, nick: 'Alice', globalOrdinal: 1000, heroOrdinal: 1000 },
          { slot: 7, nick: 'Bob', globalOrdinal: 1000, heroOrdinal: 1000 },
        ],
        winChance: { teamAPercent: 70, teamBPercent: 30 },
        balanceSuggestion: {
          kind: 'move',
          fromSlot: 7,
          toSlot: 2,
          fromNick: 'Bob',
          resultingWinChance: { teamAPercent: 51, teamBPercent: 49 },
        },
      },
    });
    const fields = embed.data.fields ?? [];
    expect(fields.some((f) => f.name === 'Balance hint')).toBe(false);
  });
});

describe('buildMatchCompletedEmbed', () => {
  it('shows the winner, quitter markers, and ki deltas', () => {
    const embed = buildMatchCompletedEmbed(
      'match-123',
      [
        { slot: 1, nick: 'goku' },
        { slot: 7, nick: 'vegeta' },
      ],
      {
        winningTeam: 1,
        ratingPreview: {
          players: [
            {
              slot: 1,
              nick: 'goku',
              globalOrdinal: 1186,
              heroOrdinal: 1200,
              globalDelta: 186,
              heroDelta: 200,
              isQuitter: true,
            },
            {
              slot: 7,
              nick: 'vegeta',
              globalOrdinal: 3300,
              heroOrdinal: 4400,
              globalDelta: -50,
              heroDelta: -80,
            },
          ],
        },
      },
    );

    const json = embed.toJSON();

    expect(json.title).toBe('Match Completed');
    expect(json.description).toBe('Team A won the match.');
    expect(json.fields?.[0]?.value).toContain('1186 (+186) / 1200 (+200)');
    expect(json.fields?.[0]?.value).toContain('🚪');
    expect(json.fields?.[1]?.value).toContain('3300 (-50) / 4400 (-80)');
    expect(json.fields?.[1]?.value).not.toContain('🚪');
    expect(json.footer?.text).toBe('Per player: global / hero (ki)');
    expect(json.color).toBe(0xf1c40f);
  });
});
