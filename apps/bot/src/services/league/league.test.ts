import { describe, expect, it } from 'vitest';
import { isLeagueWritable, LEAGUE_ARCHIVED_MESSAGE } from './league.js';

describe('isLeagueWritable', () => {
  it('allows active leagues for bind and other writes', () => {
    expect(isLeagueWritable({ status: 'ACTIVE' })).toBe(true);
  });

  it('rejects archived leagues with the shared archived message', () => {
    expect(isLeagueWritable({ status: 'ARCHIVED' })).toBe(false);
    expect(LEAGUE_ARCHIVED_MESSAGE).toMatch(/archived/i);
  });
});
