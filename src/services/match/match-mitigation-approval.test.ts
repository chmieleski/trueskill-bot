import { describe, expect, it } from 'vitest';
import {
  buildMitigationApprovalCustomId,
  parseMitigationApprovalCustomId,
} from './match-mitigation-approval.js';

describe('buildMitigationApprovalCustomId / parseMitigationApprovalCustomId', () => {
  it('round-trips approve and reject', () => {
    expect(
      parseMitigationApprovalCustomId(buildMitigationApprovalCustomId('approve', 'm1')),
    ).toEqual({ action: 'approve', matchId: 'm1' });
    expect(
      parseMitigationApprovalCustomId(buildMitigationApprovalCustomId('reject', 'm1')),
    ).toEqual({ action: 'reject', matchId: 'm1' });
  });

  it('round-trips set with percent', () => {
    expect(
      parseMitigationApprovalCustomId(buildMitigationApprovalCustomId('set', 'm1', 35)),
    ).toEqual({ action: 'set', matchId: 'm1', percent: 35 });
    expect(
      parseMitigationApprovalCustomId(buildMitigationApprovalCustomId('set', 'm1', 0)),
    ).toEqual({ action: 'set', matchId: 'm1', percent: 0 });
  });

  it('returns null for unrelated ids', () => {
    expect(parseMitigationApprovalCustomId('match:rw:ok:m1:1:-:-:0')).toBeNull();
  });
});
