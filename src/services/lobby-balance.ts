import { predictWin } from 'openskill';
import {
  roundWinPercents,
  splitRosterByTeam,
  toOpenSkillRatings,
} from './rating-math.js';

const TEAM_A_MAX = 6;
const ALL_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

export type MuSigma = { mu: number; sigma: number };

export type BalanceRosterEntry = {
  playerId: string;
  slot: number;
  heroId: number;
  nick: string;
};

export type BalanceRatingLookup = {
  global: (playerId: string) => MuSigma;
  hero: (playerId: string, heroId: number) => MuSigma;
};

export type BalanceSuggestion = {
  kind: 'swap' | 'move';
  fromSlot: number;
  toSlot: number;
  fromNick: string;
  toNick?: string;
  resultingWinChance: { teamAPercent: number; teamBPercent: number };
};

export function isUnbalancedWinChance(teamAPercent: number): boolean {
  return teamAPercent < 45 || teamAPercent > 55;
}

function imbalance(teamAPercent: number): number {
  return Math.abs(50 - teamAPercent);
}

function teamCountsOk(roster: BalanceRosterEntry[]): boolean {
  const { teamA, teamB } = splitRosterByTeam(roster);
  return teamA.length >= 1 && teamB.length >= 1;
}

function winChanceForRoster(
  roster: BalanceRosterEntry[],
  lookup: BalanceRatingLookup,
): { teamAPercent: number; teamBPercent: number } | undefined {
  if (!teamCountsOk(roster)) {
    return undefined;
  }

  const { teamA, teamB } = splitRosterByTeam(roster);
  const entities = (team: BalanceRosterEntry[]) => {
    const list: MuSigma[] = [];
    for (const entry of team) {
      list.push(lookup.global(entry.playerId));
      list.push(lookup.hero(entry.playerId, entry.heroId));
    }
    return toOpenSkillRatings(list);
  };

  const [pA, pB] = predictWin([entities(teamA), entities(teamB)]);
  return roundWinPercents(pA ?? 0.5, pB ?? 0.5);
}

function applySwap(
  roster: BalanceRosterEntry[],
  slotA: number,
  slotB: number,
): BalanceRosterEntry[] {
  const a = roster.find((e) => e.slot === slotA)!;
  const b = roster.find((e) => e.slot === slotB)!;
  return roster.map((entry) => {
    if (entry.slot === slotA) {
      return { playerId: b.playerId, nick: b.nick, slot: slotA, heroId: slotA };
    }
    if (entry.slot === slotB) {
      return { playerId: a.playerId, nick: a.nick, slot: slotB, heroId: slotB };
    }
    return entry;
  });
}

function applyMove(
  roster: BalanceRosterEntry[],
  fromSlot: number,
  toSlot: number,
): BalanceRosterEntry[] {
  return roster.map((entry) =>
    entry.slot === fromSlot
      ? { ...entry, slot: toSlot, heroId: toSlot }
      : entry,
  );
}

/** Exposed for tie-break unit tests. */
export function compareSuggestions(a: BalanceSuggestion, b: BalanceSuggestion): number {
  const imbDiff =
    imbalance(a.resultingWinChance.teamAPercent) -
    imbalance(b.resultingWinChance.teamAPercent);
  if (imbDiff !== 0) {
    return imbDiff;
  }
  if (a.kind !== b.kind) {
    return a.kind === 'swap' ? -1 : 1;
  }
  if (a.fromSlot !== b.fromSlot) {
    return a.fromSlot - b.fromSlot;
  }
  return a.toSlot - b.toSlot;
}

export function suggestBalanceMove(
  roster: BalanceRosterEntry[],
  lookup: BalanceRatingLookup,
  currentWinChance: { teamAPercent: number; teamBPercent: number },
): BalanceSuggestion | undefined {
  if (!isUnbalancedWinChance(currentWinChance.teamAPercent)) {
    return undefined;
  }

  if (!teamCountsOk(roster)) {
    return undefined;
  }

  const currentImbalance = imbalance(currentWinChance.teamAPercent);
  const occupied = new Set(roster.map((e) => e.slot));
  const emptySlots = ALL_SLOTS.filter((slot) => !occupied.has(slot));
  const teamA = roster.filter((e) => e.slot <= TEAM_A_MAX);
  const teamB = roster.filter((e) => e.slot > TEAM_A_MAX);

  const candidates: BalanceSuggestion[] = [];

  for (const a of teamA) {
    for (const b of teamB) {
      const next = applySwap(roster, a.slot, b.slot);
      const wc = winChanceForRoster(next, lookup);
      if (!wc || imbalance(wc.teamAPercent) >= currentImbalance) {
        continue;
      }
      candidates.push({
        kind: 'swap',
        fromSlot: a.slot,
        toSlot: b.slot,
        fromNick: a.nick,
        toNick: b.nick,
        resultingWinChance: wc,
      });
    }
  }

  for (const entry of roster) {
    for (const toSlot of emptySlots) {
      const next = applyMove(roster, entry.slot, toSlot);
      if (!teamCountsOk(next)) {
        continue;
      }
      const wc = winChanceForRoster(next, lookup);
      if (!wc || imbalance(wc.teamAPercent) >= currentImbalance) {
        continue;
      }
      candidates.push({
        kind: 'move',
        fromSlot: entry.slot,
        toSlot,
        fromNick: entry.nick,
        resultingWinChance: wc,
      });
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }

  candidates.sort(compareSuggestions);
  return candidates[0];
}

export function formatBalanceHint(suggestion: BalanceSuggestion): string {
  const { teamAPercent, teamBPercent } = suggestion.resultingWinChance;
  if (suggestion.kind === 'swap') {
    return `Swap ${suggestion.fromNick} (${suggestion.fromSlot}) ↔ ${suggestion.toNick} (${suggestion.toSlot}) → ~${teamAPercent}% / ${teamBPercent}%`;
  }
  return `Move ${suggestion.fromNick} (${suggestion.fromSlot}) → slot ${suggestion.toSlot} → ~${teamAPercent}% / ${teamBPercent}%`;
}
