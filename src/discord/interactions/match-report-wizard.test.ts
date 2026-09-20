import { describe, expect, it } from 'vitest';
import {
  buildReportConfirmCustomId,
  buildReportQuitterSelectOptions,
  buildReportSuggestedWinnerCustomId,
  buildReportWinnerCustomId,
  decodeReportSlots,
  encodeReportSlots,
  parseReportConfirmCustomId,
  parseReportSuggestedWinnerCustomId,
  parseReportWinnerCustomId,
} from './match-report-wizard.js';

describe('encodeReportSlots / decodeReportSlots', () => {
  it('round-trips sorted unique slots', () => {
    expect(decodeReportSlots(encodeReportSlots([7, 1, 3, 1]))).toEqual([1, 3, 7]);
  });

  it('encodes an empty list as a dash', () => {
    expect(encodeReportSlots([])).toBe('-');
    expect(decodeReportSlots('-')).toEqual([]);
  });
});

describe('buildReportConfirmCustomId / parseReportConfirmCustomId', () => {
  it('round-trips griefer, quitter slots, and mitigation', () => {
    const customId = buildReportConfirmCustomId('match-abc', 2, [2, 8], [1, 7], 35);
    expect(customId).toBe('match:rw:ok:match-abc:2:2-8:1-7:35');
    expect(parseReportConfirmCustomId(customId)).toEqual({
      matchId: 'match-abc',
      winningTeam: 2,
      grieferSlots: [2, 8],
      quitterSlots: [1, 7],
      mitigationPercent: 35,
    });
  });

  it('defaults mitigation to 0 when omitted from builder', () => {
    expect(buildReportConfirmCustomId('match-abc', 1, [], [])).toBe(
      'match:rw:ok:match-abc:1:-:-:0',
    );
  });

  it('returns null for unrelated custom ids', () => {
    expect(parseReportConfirmCustomId('match:rw:win:abc:1:-:-')).toBeNull();
  });
});

describe('buildReportWinnerCustomId / buildReportSuggestedWinnerCustomId', () => {
  it('uses distinct custom ids for the same winning team', () => {
    const winner = buildReportWinnerCustomId('match-abc', 2, [], []);
    const suggested = buildReportSuggestedWinnerCustomId('match-abc', 2, [], []);

    expect(winner).toBe('match:rw:win:match-abc:2:-:-');
    expect(suggested).toBe('match:rw:suggested:match-abc:2:-:-');
    expect(winner).not.toBe(suggested);
  });

  it('parses winner and suggested custom ids', () => {
    const payload = {
      matchId: 'match-abc',
      winningTeam: 2 as const,
      grieferSlots: [2, 8],
      quitterSlots: [1, 7],
    };

    expect(
      parseReportWinnerCustomId(buildReportWinnerCustomId('match-abc', 2, [2, 8], [1, 7])),
    ).toEqual(payload);
    expect(
      parseReportSuggestedWinnerCustomId(
        buildReportSuggestedWinnerCustomId('match-abc', 2, [2, 8], [1, 7]),
      ),
    ).toEqual(payload);
  });
});

describe('buildReportQuitterSelectOptions', () => {
  const players = [
    { slot: 1, isQuitter: false, player: { username: 'goku' } },
    { slot: 2, isQuitter: true, player: { username: 'gohan' } },
    { slot: 7, isQuitter: false, player: { username: 'vegeta' } },
    { slot: 8, isQuitter: true, player: { username: 'cell' } },
  ];

  it('excludes griefer slots from quitter options', () => {
    const options = buildReportQuitterSelectOptions(players, [2, 8]);
    expect(options.map((option) => option.value)).toEqual(['1', '7']);
  });

  it('preserves default quitter flags on eligible slots', () => {
    const options = buildReportQuitterSelectOptions(players, [8]);
    expect(options).toEqual([
      { label: 'Slot 1: goku', value: '1', default: false },
      { label: 'Slot 2: gohan', value: '2', default: true },
      { label: 'Slot 7: vegeta', value: '7', default: false },
    ]);
  });
});
