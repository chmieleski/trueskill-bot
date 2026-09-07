import { describe, expect, it } from 'vitest';
import {
  buildApprovalApproveCustomId,
  buildApprovalGriefersCustomId,
  buildApprovalQuittersCustomId,
  buildApprovalRejectCustomId,
  buildApprovalWinCustomId,
  buildApprovalWinnerCustomId,
  decodeApprovalSlots,
  encodeApprovalSlots,
  parseMatchApprovalCustomId,
} from './match-approval-preview.js';

describe('match approval custom ids', () => {
  it('builds and parses button actions', () => {
    expect(parseMatchApprovalCustomId(buildApprovalQuittersCustomId('m1'))).toEqual({
      kind: 'quitters',
      matchId: 'm1',
    });
    expect(parseMatchApprovalCustomId(buildApprovalGriefersCustomId('m1'))).toEqual({
      kind: 'griefers',
      matchId: 'm1',
    });
    expect(parseMatchApprovalCustomId(buildApprovalWinnerCustomId('m1'))).toEqual({
      kind: 'winner',
      matchId: 'm1',
    });
    expect(parseMatchApprovalCustomId(buildApprovalWinCustomId('m1', 2))).toEqual({
      kind: 'win',
      matchId: 'm1',
      winningTeam: 2,
    });
    expect(parseMatchApprovalCustomId(buildApprovalApproveCustomId('m1'))).toEqual({
      kind: 'approve',
      matchId: 'm1',
    });
    expect(parseMatchApprovalCustomId(buildApprovalRejectCustomId('m1'))).toEqual({
      kind: 'reject',
      matchId: 'm1',
    });
  });

  it('encodes and decodes slot lists', () => {
    expect(encodeApprovalSlots([3, 1, 1])).toBe('1-3');
    expect(decodeApprovalSlots('1-3')).toEqual([1, 3]);
    expect(decodeApprovalSlots('-')).toEqual([]);
    expect(decodeApprovalSlots(undefined)).toEqual([]);
  });

  it('returns null for non-approval or malformed ids', () => {
    expect(parseMatchApprovalCustomId('match:rw:win:m1:1:-:-')).toBeNull();
    expect(parseMatchApprovalCustomId('match:ap:win:m1:3')).toBeNull();
    expect(parseMatchApprovalCustomId('match:ap:approve')).toBeNull();
  });
});
