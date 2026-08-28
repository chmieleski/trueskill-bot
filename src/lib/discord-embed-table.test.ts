import { describe, expect, it } from 'vitest';
import {
  DISCORD_CODE_BLOCK_TARGET_LINE_WIDTH,
  formatMonospaceTable,
  truncateDiscordFieldValue,
} from './discord-embed-table.js';

describe('truncateDiscordFieldValue', () => {
  it('truncates at the Discord field limit with an ellipsis', () => {
    const text = 'a'.repeat(1025);
    const truncated = truncateDiscordFieldValue(text);
    expect(truncated).toHaveLength(1024);
    expect(truncated.endsWith('…')).toBe(true);
  });
});

describe('formatMonospaceTable', () => {
  it('keeps each line within the target embed code-block width', () => {
    const table = formatMonospaceTable(
      [
        {
          player: 'dragonnpx4',
          hero: 'Sawada Tsunayoshi',
          kda: '30/9',
          dmg: '217.7k',
        },
      ],
      [
        { header: 'Player', align: 'left', maxWidth: 10, cell: (row) => row.player },
        { header: 'Hero', align: 'left', maxWidth: 14, cell: (row) => row.hero },
        { header: 'K/D', align: 'right', maxWidth: 5, cell: (row) => row.kda },
        { header: 'Dmg', align: 'right', maxWidth: 5, cell: (row) => row.dmg },
      ],
    );

    const lines = table
      .replace(/^```\n/, '')
      .replace(/\n```$/, '')
      .split('\n');

    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(DISCORD_CODE_BLOCK_TARGET_LINE_WIDTH);
    }
  });
});
