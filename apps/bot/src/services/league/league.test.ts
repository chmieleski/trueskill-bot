import { describe, expect, it } from 'vitest';
import {
  isLeagueAcceptingPlay,
  isLeagueSeasonPaused,
  isLeagueWritable,
  LEAGUE_ARCHIVED_MESSAGE,
  LEAGUE_SEASON_PAUSED_MESSAGE,
} from './league.js';

const NOW = new Date('2026-09-01T12:00:00.000Z');
const PAST = new Date('2026-08-01T00:00:00.000Z');
const FUTURE = new Date('2026-10-01T00:00:00.000Z');

describe('isLeagueWritable', () => {
  it('allows active leagues for bind and other writes', () => {
    expect(isLeagueWritable({ status: 'ACTIVE' })).toBe(true);
  });

  it('rejects archived leagues with the shared archived message', () => {
    expect(isLeagueWritable({ status: 'ARCHIVED' })).toBe(false);
    expect(LEAGUE_ARCHIVED_MESSAGE).toMatch(/archived/i);
  });
});

describe('isLeagueSeasonPaused', () => {
  it('is false when seasonEndsAt is null', () => {
    expect(isLeagueSeasonPaused({ status: 'ACTIVE', seasonEndsAt: null }, NOW)).toBe(false);
  });

  it('is false when seasonEndsAt is still in the future', () => {
    expect(isLeagueSeasonPaused({ status: 'ACTIVE', seasonEndsAt: FUTURE }, NOW)).toBe(false);
  });

  it('is true at and after seasonEndsAt for an active league', () => {
    expect(isLeagueSeasonPaused({ status: 'ACTIVE', seasonEndsAt: NOW }, NOW)).toBe(true);
    expect(isLeagueSeasonPaused({ status: 'ACTIVE', seasonEndsAt: PAST }, NOW)).toBe(true);
  });

  it('is false for archived leagues even after seasonEndsAt', () => {
    expect(isLeagueSeasonPaused({ status: 'ARCHIVED', seasonEndsAt: PAST }, NOW)).toBe(false);
  });
});

describe('isLeagueAcceptingPlay', () => {
  it('allows active leagues before season end', () => {
    expect(isLeagueAcceptingPlay({ status: 'ACTIVE', seasonEndsAt: FUTURE }, NOW)).toBe(true);
    expect(isLeagueAcceptingPlay({ status: 'ACTIVE', seasonEndsAt: null }, NOW)).toBe(true);
  });

  it('rejects paused and archived leagues', () => {
    expect(isLeagueAcceptingPlay({ status: 'ACTIVE', seasonEndsAt: PAST }, NOW)).toBe(false);
    expect(isLeagueAcceptingPlay({ status: 'ARCHIVED', seasonEndsAt: null }, NOW)).toBe(false);
    expect(LEAGUE_SEASON_PAUSED_MESSAGE).toMatch(/paused/i);
  });
});
