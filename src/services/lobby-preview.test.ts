import { describe, expect, it } from 'vitest';
import {
  buildMatchCompletedEmbed,
  buildMatchReportButtons,
  formatTeamLinesFromPreview,
} from './lobby-preview.js';

describe('formatTeamLinesFromPreview', () => {
  it('appends the quitter marker outside the code span', () => {
    const value = formatTeamLinesFromPreview([
      { slot: 1, nick: 'goku', globalOrdinal: 11, heroOrdinal: 22, isQuitter: true },
      { slot: 7, nick: 'vegeta', globalOrdinal: 33, heroOrdinal: 44 },
    ]);
    const [firstLine, secondLine] = value.split('\n');

    expect(firstLine).toContain('`goku');
    expect(firstLine).toContain('🚪');
    expect(firstLine).toMatch(/`\s*goku\s+11 \/  22`\s+🚪$/);
    expect(secondLine).toContain('`vegeta');
    expect(secondLine).not.toContain('🚪');
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

describe('buildMatchCompletedEmbed', () => {
  it('shows the winner and quitter markers', () => {
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
              globalOrdinal: 11,
              heroOrdinal: 22,
              isQuitter: true,
            },
            {
              slot: 7,
              nick: 'vegeta',
              globalOrdinal: 33,
              heroOrdinal: 44,
            },
          ],
        },
      },
    );

    const json = embed.toJSON();

    expect(json.title).toBe('Match Completed');
    expect(json.description).toBe('Team A won the match.');
    expect(json.fields?.[0]?.value).toContain('🚪');
    expect(json.fields?.[1]?.value).not.toContain('🚪');
    expect(json.color).toBe(0xf1c40f);
  });
});
