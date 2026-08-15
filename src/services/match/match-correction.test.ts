import { describe, expect, it } from 'vitest';
import {
  CORRECTION_WINDOW_MS,
  GLOBAL_SNAPSHOT_HERO_ID,
  isWithinCorrectionWindow,
  parseMatchCorrectionButtonCustomId,
  buildMatchCorrectionConfirmCustomId,
} from './match-correction.js';

describe('match correction constants', () => {
  it('uses a 24h window', () => {
    expect(CORRECTION_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('uses heroId sentinel 0 for GLOBAL rows', () => {
    expect(GLOBAL_SNAPSHOT_HERO_ID).toBe(0);
  });
});

describe('isWithinCorrectionWindow', () => {
  it('accepts completedAt within 24h', () => {
    expect(isWithinCorrectionWindow(new Date(Date.now() - 1000), Date.now())).toBe(true);
  });

  it('rejects null completedAt', () => {
    expect(isWithinCorrectionWindow(null, Date.now())).toBe(false);
  });

  it('rejects older than 24h', () => {
    const old = new Date(Date.now() - CORRECTION_WINDOW_MS - 1);
    expect(isWithinCorrectionWindow(old, Date.now())).toBe(false);
  });

  it('accepts completedAt exactly at the boundary', () => {
    const exact = new Date(Date.now() - CORRECTION_WINDOW_MS);
    expect(isWithinCorrectionWindow(exact, Date.now())).toBe(true);
  });
});

describe('matchcorr customId', () => {
  it('round-trips flip confirm', () => {
    const id = buildMatchCorrectionConfirmCustomId({
      action: 'flip',
      matchId: 'clxxxxxxxxxxxxxxxxxxxxxx',
      actorDiscordId: '123456789012345678',
      winningTeam: 2,
      quitterSlots: [1, 7],
    });
    expect(id.length).toBeLessThanOrEqual(100);
    expect(parseMatchCorrectionButtonCustomId(id)).toEqual({
      kind: 'confirm',
      action: 'flip',
      matchId: 'clxxxxxxxxxxxxxxxxxxxxxx',
      actorDiscordId: '123456789012345678',
      winningTeam: 2,
      quitterSlots: [1, 7],
    });
  });

  it('round-trips void confirm', () => {
    const id = buildMatchCorrectionConfirmCustomId({
      action: 'void',
      matchId: 'clxxxxxxxxxxxxxxxxxxxxxx',
      actorDiscordId: '123456789012345678',
    });
    expect(parseMatchCorrectionButtonCustomId(id)?.action).toBe('void');
    expect(parseMatchCorrectionButtonCustomId(id)?.kind).toBe('confirm');
  });

  it('round-trips flip confirm with no quitters', () => {
    const id = buildMatchCorrectionConfirmCustomId({
      action: 'flip',
      matchId: 'clxxxxxxxxxxxxxxxxxxxxxx',
      actorDiscordId: '123456789012345678',
      winningTeam: 1,
      quitterSlots: [],
    });
    const parsed = parseMatchCorrectionButtonCustomId(id);
    expect(parsed).toMatchObject({ action: 'flip', winningTeam: 1, quitterSlots: [] });
  });

  it('returns null for unknown prefix', () => {
    expect(parseMatchCorrectionButtonCustomId('match:ok:f:foo:bar:1:–')).toBeNull();
  });

  it('cancel customId parses to kind=cancel', () => {
    const id = buildMatchCorrectionConfirmCustomId({
      action: 'flip',
      matchId: 'clxxxxxxxxxxxxxxxxxxxxxx',
      actorDiscordId: '123456789012345678',
      winningTeam: 1,
      quitterSlots: [],
    });
    // Replace ok with no to simulate a cancel customId
    const cancelId = id.replace('matchcorr:ok:', 'matchcorr:no:');
    const parsed = parseMatchCorrectionButtonCustomId(cancelId);
    expect(parsed?.kind).toBe('cancel');
    expect(parsed?.action).toBe('flip');
  });
});
