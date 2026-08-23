import { beforeEach, describe, expect, it, vi } from 'vitest';

const { update } = vi.hoisted(() => ({
  update: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { update },
  },
}));

import {
  LEAGUE_DECAY_ARCHIVED_MESSAGE,
  parseSeasonEndDate,
  setDecayEnabled,
} from './league-decay.js';

describe('parseSeasonEndDate', () => {
  const now = new Date('2026-08-24T12:00:00.000Z');

  it('parses YYYY-MM-DD as UTC end of that calendar day', () => {
    const date = parseSeasonEndDate('2026-09-01', now);
    expect(date.toISOString()).toBe('2026-09-01T23:59:59.999Z');
  });

  it('parses a full ISO datetime', () => {
    const date = parseSeasonEndDate('2026-09-01T15:30:00.000Z', now);
    expect(date.toISOString()).toBe('2026-09-01T15:30:00.000Z');
  });

  it('trims surrounding whitespace', () => {
    const date = parseSeasonEndDate('  2026-09-01  ', now);
    expect(date.toISOString()).toBe('2026-09-01T23:59:59.999Z');
  });

  it('rejects unparseable input with the exact message', () => {
    expect(() => parseSeasonEndDate('not-a-date', now)).toThrow(
      'Could not parse that date. Use YYYY-MM-DD or a full date/time.',
    );
  });

  it('rejects a past calendar day', () => {
    expect(() => parseSeasonEndDate('2026-08-20', now)).toThrow(
      'Season end must be in the future.',
    );
  });

  it('rejects a datetime equal to now', () => {
    expect(() => parseSeasonEndDate('2026-08-24T12:00:00.000Z', now)).toThrow(
      'Season end must be in the future.',
    );
  });

  it('rejects a datetime earlier than now', () => {
    expect(() => parseSeasonEndDate('2026-08-24T11:59:59.999Z', now)).toThrow(
      'Season end must be in the future.',
    );
  });
});

describe('LEAGUE_DECAY_ARCHIVED_MESSAGE', () => {
  it('matches the staff-command archived copy', () => {
    expect(LEAGUE_DECAY_ARCHIVED_MESSAGE).toBe('That league is archived. Pick an active league.');
  });
});

describe('setDecayEnabled', () => {
  beforeEach(() => {
    update.mockReset();
  });

  it('persists the decay toggle on the league row', async () => {
    await setDecayEnabled('league-1', false);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'league-1' },
      data: { decayEnabled: false },
    });
  });
});
