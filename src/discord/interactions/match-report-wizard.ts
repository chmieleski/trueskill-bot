/** Pure helpers for Report Winner custom ids and quitter select filtering. */

export function encodeReportSlots(slots: number[]): string {
  const normalized = [...new Set(slots)].sort((a, b) => a - b);
  return normalized.length > 0 ? normalized.join('-') : '-';
}

export function decodeReportSlots(slotsCsv: string | undefined): number[] {
  if (!slotsCsv || slotsCsv === '-') {
    return [];
  }

  return slotsCsv
    .split('-')
    .map((slot) => Number(slot))
    .filter((slot) => Number.isInteger(slot));
}

export function buildReportWinnerCustomId(
  matchId: string,
  winningTeam: 1 | 2,
  grieferSlots: number[],
  quitterSlots: number[],
): string {
  return `match:rw:win:${matchId}:${winningTeam}:${encodeReportSlots(grieferSlots)}:${encodeReportSlots(quitterSlots)}`;
}

/** Distinct from {@link buildReportWinnerCustomId} so Discord does not reject duplicate component ids. */
export function buildReportSuggestedWinnerCustomId(
  matchId: string,
  winningTeam: 1 | 2,
  grieferSlots: number[],
  quitterSlots: number[],
): string {
  return `match:rw:suggested:${matchId}:${winningTeam}:${encodeReportSlots(grieferSlots)}:${encodeReportSlots(quitterSlots)}`;
}

export function buildReportConfirmCustomId(
  matchId: string,
  winningTeam: 1 | 2,
  grieferSlots: number[],
  quitterSlots: number[],
): string {
  return `match:rw:ok:${matchId}:${winningTeam}:${encodeReportSlots(grieferSlots)}:${encodeReportSlots(quitterSlots)}`;
}

export function parseReportConfirmCustomId(customId: string): {
  matchId: string;
  winningTeam: 1 | 2;
  grieferSlots: number[];
  quitterSlots: number[];
} | null {
  const parts = customId.split(':');
  if (parts.length !== 7 || parts[0] !== 'match' || parts[1] !== 'rw' || parts[2] !== 'ok') {
    return null;
  }

  const matchId = parts[3];
  const teamRaw = parts[4];
  if (!matchId || (teamRaw !== '1' && teamRaw !== '2')) {
    return null;
  }

  return {
    matchId,
    winningTeam: Number(teamRaw) as 1 | 2,
    grieferSlots: decodeReportSlots(parts[5]),
    quitterSlots: decodeReportSlots(parts[6]),
  };
}

export function parseReportWinnerCustomId(customId: string): {
  matchId: string;
  winningTeam: 1 | 2;
  grieferSlots: number[];
  quitterSlots: number[];
} | null {
  const parts = customId.split(':');
  if (parts.length !== 7 || parts[0] !== 'match' || parts[1] !== 'rw' || parts[2] !== 'win') {
    return null;
  }

  const matchId = parts[3];
  const teamRaw = parts[4];
  if (!matchId || (teamRaw !== '1' && teamRaw !== '2')) {
    return null;
  }

  return {
    matchId,
    winningTeam: Number(teamRaw) as 1 | 2,
    grieferSlots: decodeReportSlots(parts[5]),
    quitterSlots: decodeReportSlots(parts[6]),
  };
}

export function parseReportSuggestedWinnerCustomId(customId: string): {
  matchId: string;
  winningTeam: 1 | 2;
  grieferSlots: number[];
  quitterSlots: number[];
} | null {
  const parts = customId.split(':');
  if (parts.length !== 7 || parts[0] !== 'match' || parts[1] !== 'rw' || parts[2] !== 'suggested') {
    return null;
  }

  const matchId = parts[3];
  const teamRaw = parts[4];
  if (!matchId || (teamRaw !== '1' && teamRaw !== '2')) {
    return null;
  }

  return {
    matchId,
    winningTeam: Number(teamRaw) as 1 | 2,
    grieferSlots: decodeReportSlots(parts[5]),
    quitterSlots: decodeReportSlots(parts[6]),
  };
}

type ReportQuitterPlayer = {
  slot: number;
  isQuitter: boolean;
  player: { username: string };
};

/** Quitter multi-select options with griefer slots excluded (mutual exclusivity). */
export function buildReportQuitterSelectOptions(
  players: ReportQuitterPlayer[],
  grieferSlots: number[],
): Array<{ label: string; value: string; default: boolean }> {
  const grieferSet = new Set(grieferSlots);

  return [...players]
    .sort((left, right) => left.slot - right.slot)
    .filter((player) => !grieferSet.has(player.slot))
    .map((player) => ({
      label: `Slot ${player.slot}: ${player.player.username}`.slice(0, 100),
      value: String(player.slot),
      default: player.isQuitter,
    }));
}
