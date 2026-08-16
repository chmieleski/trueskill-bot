import { predictWin } from 'openskill';
import {
  getGameProfile,
  rosterHeroId,
  teamForSlot,
  type GameProfile,
} from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';
import { ratingEntitiesForPlayer } from '../rating/rating-entities.js';
import {
  roundWinPercents,
  splitRosterByTeam,
  toOpenSkillRatings,
} from '../rating/rating-math.js';

export type MuSigma = { mu: number; sigma: number };

export type BalanceRosterEntry = {
  playerId: string;
  slot: number;
  team: 1 | 2;
  heroId: number | null;
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

function resolvedProfile(profile?: GameProfile): GameProfile {
  return profile ?? getGameProfile(WARCRAFT3_UDBR_GAME_ID);
}

function emptySlotsForProfile(profile: GameProfile, occupied: Set<number>): number[] {
  const empty: number[] = [];
  for (let slot = 1; slot <= profile.slotCount; slot += 1) {
    if (!occupied.has(slot)) {
      empty.push(slot);
    }
  }
  return empty;
}

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
      const global = lookup.global(entry.playerId);
      const hero =
        entry.heroId == null ? global : lookup.hero(entry.playerId, entry.heroId);
      list.push(...ratingEntitiesForPlayer(global, hero, entry.heroId));
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
  profile: GameProfile,
): BalanceRosterEntry[] {
  const a = roster.find((e) => e.slot === slotA)!;
  const b = roster.find((e) => e.slot === slotB)!;
  return roster.map((entry) => {
    if (entry.slot === slotA) {
      return {
        playerId: b.playerId,
        nick: b.nick,
        slot: slotA,
        heroId: rosterHeroId(profile, slotA),
        team: entry.team,
      };
    }
    if (entry.slot === slotB) {
      return {
        playerId: a.playerId,
        nick: a.nick,
        slot: slotB,
        heroId: rosterHeroId(profile, slotB),
        team: entry.team,
      };
    }
    return entry;
  });
}

function applyMove(
  roster: BalanceRosterEntry[],
  fromSlot: number,
  toSlot: number,
  profile: GameProfile,
): BalanceRosterEntry[] {
  return roster.map((entry) =>
    entry.slot === fromSlot
      ? {
          ...entry,
          slot: toSlot,
          heroId: rosterHeroId(profile, toSlot),
          team: teamForSlot(profile, toSlot),
        }
      : entry,
  );
}

/** Max distinct advisory moves shown on the Match Lobby embed. */
export const MAX_BALANCE_SUGGESTIONS = 3;

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

/**
 * Empty-slot moves for the same player (e.g. nick → slots 6/7/8) count as one
 * suggestion — keep the best destination. Swaps stay distinct.
 */
export function dedupeEmptySlotMoves(candidates: BalanceSuggestion[]): BalanceSuggestion[] {
  const bestMoveByFromSlot = new Map<number, BalanceSuggestion>();
  const swaps: BalanceSuggestion[] = [];

  for (const candidate of candidates) {
    if (candidate.kind === 'swap') {
      swaps.push(candidate);
      continue;
    }
    const existing = bestMoveByFromSlot.get(candidate.fromSlot);
    if (!existing || compareSuggestions(candidate, existing) < 0) {
      bestMoveByFromSlot.set(candidate.fromSlot, candidate);
    }
  }

  return [...swaps, ...bestMoveByFromSlot.values()];
}

/**
 * Returns up to {@link MAX_BALANCE_SUGGESTIONS} improving single moves, best first.
 * Same-player empty-slot destinations collapse to one entry (best free slot).
 */
export function suggestBalanceMoves(
  roster: BalanceRosterEntry[],
  lookup: BalanceRatingLookup,
  currentWinChance: { teamAPercent: number; teamBPercent: number },
  profile?: GameProfile,
): BalanceSuggestion[] {
  if (!isUnbalancedWinChance(currentWinChance.teamAPercent)) {
    return [];
  }

  if (!teamCountsOk(roster)) {
    return [];
  }

  const resolved = resolvedProfile(profile);
  const currentImbalance = imbalance(currentWinChance.teamAPercent);
  const occupied = new Set(roster.map((e) => e.slot));
  const emptySlots = emptySlotsForProfile(resolved, occupied);
  const { teamA, teamB } = splitRosterByTeam(roster);

  const candidates: BalanceSuggestion[] = [];

  for (const a of teamA) {
    for (const b of teamB) {
      const next = applySwap(roster, a.slot, b.slot, resolved);
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
      const next = applyMove(roster, entry.slot, toSlot, resolved);
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
    return [];
  }

  const deduped = dedupeEmptySlotMoves(candidates);
  deduped.sort(compareSuggestions);
  return deduped.slice(0, MAX_BALANCE_SUGGESTIONS);
}

/** Best single improving move, or undefined when none. */
export function suggestBalanceMove(
  roster: BalanceRosterEntry[],
  lookup: BalanceRatingLookup,
  currentWinChance: { teamAPercent: number; teamBPercent: number },
  profile?: GameProfile,
): BalanceSuggestion | undefined {
  return suggestBalanceMoves(roster, lookup, currentWinChance, profile)[0];
}

export function formatBalanceHint(suggestion: BalanceSuggestion): string {
  const { teamAPercent, teamBPercent } = suggestion.resultingWinChance;
  if (suggestion.kind === 'swap') {
    return `Swap ${suggestion.fromNick} (${suggestion.fromSlot}) ↔ ${suggestion.toNick} (${suggestion.toSlot}) → ~${teamAPercent}% / ${teamBPercent}%`;
  }
  return `Move ${suggestion.fromNick} (${suggestion.fromSlot}) → empty slot ${suggestion.toSlot} → ~${teamAPercent}% / ${teamBPercent}%`;
}

/** Formats up to three hints as a numbered list for the lobby embed. */
export function formatBalanceHints(suggestions: BalanceSuggestion[]): string {
  if (suggestions.length === 0) {
    return '';
  }
  if (suggestions.length === 1) {
    return formatBalanceHint(suggestions[0]!);
  }
  return suggestions
    .map((suggestion, index) => `${index + 1}. ${formatBalanceHint(suggestion)}`)
    .join('\n');
}
