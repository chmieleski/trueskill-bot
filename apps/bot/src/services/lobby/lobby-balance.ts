import { predictWin } from 'openskill';
import {
  getGameProfile,
  rosterHeroId,
  teamForSlot,
  type GameProfile,
} from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';
import {
  balanceEntitiesForSeat,
  type BalancePredictWinOptions,
} from '../rating/rating-entities.js';
import {
  classifyNewSeatsForBalance,
  entryPairKey,
  isMarkedNewPlayer,
} from '../rating/new-player-partition.js';
import { normalizeNick } from '../player/player-nick.js';
import { roundWinPercents, splitRosterByTeam, toOpenSkillRatings } from '../rating/rating-math.js';
import { planSwapMoves } from './in-game-roster.js';

export type MuSigma = { mu: number; sigma: number };

export type BalanceRosterEntry = {
  playerId: string;
  slot: number;
  team: 1 | 2;
  heroId: number | null;
  nick: string;
  /** Soft lock: Balance never moves this seat. */
  locked?: boolean;
  /** Live lobby New flag for win% / Balance. */
  isNewPlayer?: boolean;
  /** Completed-match snapshot New flag. */
  wasNewPlayer?: boolean;
};

export type BalanceRatingLookup = {
  global: (playerId: string) => MuSigma;
  hero: (playerId: string, heroId: number) => MuSigma;
};

function resolvedProfile(profile?: GameProfile): GameProfile {
  return profile ?? getGameProfile(WARCRAFT3_UDBR_GAME_ID);
}

function imbalance(teamAPercent: number): number {
  return Math.abs(50 - teamAPercent);
}

function teamCountsOk(roster: BalanceRosterEntry[]): boolean {
  const { teamA, teamB } = splitRosterByTeam(roster);
  return teamA.length >= 1 && teamB.length >= 1;
}

export type { BalancePredictWinOptions } from '../rating/rating-entities.js';

function winChanceForRoster(
  roster: BalanceRosterEntry[],
  lookup: BalanceRatingLookup,
  options?: BalancePredictWinOptions,
): { teamAPercent: number; teamBPercent: number } | undefined {
  if (!teamCountsOk(roster)) {
    return undefined;
  }

  const { teamA, teamB } = splitRosterByTeam(roster);
  const newClassification = classifyNewSeatsForBalance(roster);
  const entities = (team: BalanceRosterEntry[]) => {
    const list: MuSigma[] = [];
    for (const entry of team) {
      const global = lookup.global(entry.playerId);
      const hero = entry.heroId == null ? global : lookup.hero(entry.playerId, entry.heroId);
      list.push(
        ...balanceEntitiesForSeat(
          global,
          hero,
          entry.heroId,
          entryPairKey(entry),
          newClassification,
          options,
        ),
      );
    }
    return toOpenSkillRatings(list);
  };

  const teamAEntities = entities(teamA);
  const teamBEntities = entities(teamB);
  if (teamAEntities.length === 0 || teamBEntities.length === 0) {
    return undefined;
  }

  const [pA, pB] = predictWin([teamAEntities, teamBEntities]);
  return roundWinPercents(pA ?? 0.5, pB ?? 0.5);
}

function swappedSeat(
  source: BalanceRosterEntry,
  slot: number,
  team: 1 | 2,
  profile: GameProfile,
): BalanceRosterEntry {
  return {
    playerId: source.playerId,
    nick: source.nick,
    slot,
    heroId: rosterHeroId(profile, slot),
    team,
    ...(source.isNewPlayer === true ? { isNewPlayer: true as const } : {}),
    ...(source.wasNewPlayer === true ? { wasNewPlayer: true as const } : {}),
    ...(source.locked === true ? { locked: true as const } : {}),
  };
}

/** Max rounded imbalance (|50 − teamA%|) that counts as balanced: anything from 45/55 to 55/45. */
export const BALANCE_TARGET_IMBALANCE = 5;

/** Random placements tried once one- and two-swap seatings can't reach the target. */
// ponytail: random sampling past two swaps, not exhaustive search; raise if 45–55 is often missed on solvable lobbies.
const BALANCE_ATTEMPTS = 3000;

/** New-player seats per team; `even` = gap is the minimum the count allows (0 even, 1 odd). */
export type NewPlayerSplit = { team1: number; team2: number; even: boolean };

export type BalanceResult = {
  roster: BalanceRosterEntry[];
  winChance: { teamAPercent: number; teamBPercent: number };
  /** True when the result is within {@link BALANCE_TARGET_IMBALANCE}. */
  balanced: boolean;
  /** Only uneven when locked seats force it. */
  newSplit: NewPlayerSplit;
};

function newPlayerSplit(roster: BalanceRosterEntry[]): NewPlayerSplit {
  let team1 = 0;
  let team2 = 0;
  for (const entry of roster) {
    if (!isMarkedNewPlayer(entry)) {
      continue;
    }
    if (entry.team === 1) {
      team1 += 1;
    } else {
      team2 += 1;
    }
  }
  return { team1, team2, even: Math.abs(team1 - team2) <= (team1 + team2) % 2 };
}

/** Seating score; `swaps` = in-game swap commands needed to get there from the current seating. */
type SeatingScore = { newGap: number; imbalance: number; swaps: number };

function scoreSeating(
  roster: BalanceRosterEntry[],
  winChance: { teamAPercent: number } | undefined,
  swaps: number,
): SeatingScore {
  const split = newPlayerSplit(roster);
  return {
    newGap: Math.abs(split.team1 - split.team2),
    imbalance: winChance ? imbalance(winChance.teamAPercent) : Number.POSITIVE_INFINITY,
    swaps,
  };
}

function onTarget(score: SeatingScore): boolean {
  return score.imbalance <= BALANCE_TARGET_IMBALANCE;
}

/**
 * Lower is better: New-player gap, then reaching the target, then (on target)
 * fewest swaps before best win%. Off target, win% comes first.
 */
function compareScores(left: SeatingScore, right: SeatingScore): number {
  const leftOff = onTarget(left) ? 0 : 1;
  const rightOff = onTarget(right) ? 0 : 1;
  if (left.newGap !== right.newGap || leftOff !== rightOff) {
    return left.newGap - right.newGap || leftOff - rightOff;
  }
  return leftOff === 0
    ? left.swaps - right.swaps || left.imbalance - right.imbalance
    : left.imbalance - right.imbalance || left.swaps - right.swaps;
}

/** A pick must not undo the New split or make an off-target lobby worse. */
function noWorseThanCurrent(score: SeatingScore, current: SeatingScore): boolean {
  if (score.newGap !== current.newGap) {
    return score.newGap < current.newGap;
  }
  return onTarget(score) || score.imbalance <= current.imbalance;
}

function seatingKey(roster: BalanceRosterEntry[]): string {
  return roster
    .map((entry) => `${entry.slot}:${entry.playerId}`)
    .sort()
    .join('|');
}

function fisherYatesInPlace<T>(items: T[], random: () => number): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
}

/** Unlocked seats as slot → original entry; locked and empty slots are absent. */
type Seating = Map<number, BalanceRosterEntry>;

/** Every seating one `!swap` away: two players trade seats, or one moves to an empty slot. */
function pairSwaps(seating: Seating, openSlots: number[]): Seating[] {
  const out: Seating[] = [];
  for (let i = 0; i < openSlots.length; i += 1) {
    for (let j = i + 1; j < openSlots.length; j += 1) {
      const a = openSlots[i]!;
      const b = openSlots[j]!;
      const atA = seating.get(a);
      const atB = seating.get(b);
      if (!atA && !atB) {
        continue;
      }
      const next = new Map(seating);
      next.delete(a);
      next.delete(b);
      if (atB) next.set(a, atB);
      if (atA) next.set(b, atA);
      out.push(next);
    }
  }
  return out;
}

function randomSeating(
  movers: BalanceRosterEntry[],
  openSlots: number[],
  random: () => number,
): Seating {
  const slots = [...openSlots];
  fisherYatesInPlace(slots, random);
  return new Map(movers.map((entry, index) => [slots[index]!, entry]));
}

/**
 * Re-seat unlocked players across all non-locked slots (occupied or empty) so
 * New players split evenly (half each side; odd counts within one) and win
 * chance lands within 45/55, using the fewest in-game swap commands: every
 * one-swap seating is tried, then every two-swap seating, then random
 * placements. An even New split always beats a better win%; only locked seats
 * can leave it uneven. Locked seats never move. Ties are broken at random, so
 * repeated calls return different seatings; the current seating is never
 * returned. Falls back to the closest seating found that is no worse than the
 * current one. Returns undefined when nothing can be moved or improved.
 */
export function findBalancedRoster(
  roster: BalanceRosterEntry[],
  lookup: BalanceRatingLookup,
  options?: BalancePredictWinOptions,
  profile?: GameProfile,
  random: () => number = Math.random,
): BalanceResult | undefined {
  const resolved = resolvedProfile(profile);
  const fixed = roster.filter((entry) => entry.locked === true);
  const movers = roster.filter((entry) => entry.locked !== true);
  if (movers.length === 0) {
    return undefined;
  }

  const lockedSlots = new Set(fixed.map((entry) => entry.slot));
  const openSlots: number[] = [];
  for (let slot = 1; slot <= resolved.slotCount; slot += 1) {
    if (!lockedSlots.has(slot)) {
      openSlots.push(slot);
    }
  }

  const toRoster = (seating: Seating) => [
    ...fixed,
    ...[...seating].map(([slot, entry]) =>
      swappedSeat(entry, slot, teamForSlot(resolved, slot), resolved),
    ),
  ];
  // planSwapMoves counts commands exactly as the lobby's Swap commands field will list them.
  const currentAsSnapshot = movers.map((entry) => ({
    slot: entry.slot,
    nick: normalizeNick(entry.playerId),
    rawName: entry.playerId,
  }));
  const swapsTo = (next: BalanceRosterEntry[]) =>
    planSwapMoves(
      next
        .filter((entry) => entry.locked !== true)
        .map((entry) => ({ slot: entry.slot, nick: entry.playerId })),
      currentAsSnapshot,
    ).length;

  const start: Seating = new Map(movers.map((entry) => [entry.slot, entry]));
  const current = scoreSeating(roster, winChanceForRoster(roster, lookup, options), 0);
  const currentSplit = newPlayerSplit(roster);
  const targetNewGap = (currentSplit.team1 + currentSplit.team2) % 2;
  const seen = new Set([seatingKey(roster)]);
  let oneSwap: Seating[] = [];
  const stages: Array<() => Seating[]> = [
    () => (oneSwap = pairSwaps(start, openSlots)),
    () => oneSwap.flatMap((seating) => pairSwaps(seating, openSlots)),
    () => Array.from({ length: BALANCE_ATTEMPTS }, () => randomSeating(movers, openSlots, random)),
  ];
  let best: (Pick<BalanceResult, 'roster' | 'winChance'> & { score: SeatingScore }) | undefined;

  for (const stage of stages) {
    const seatings = stage();
    fisherYatesInPlace(seatings, random);
    for (const seating of seatings) {
      const next = toRoster(seating);
      const key = seatingKey(next);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const winChance = winChanceForRoster(next, lookup, options);
      if (!winChance) {
        continue;
      }
      const score = scoreSeating(next, winChance, swapsTo(next));
      const better = best
        ? compareScores(score, best.score) < 0
        : noWorseThanCurrent(score, current);
      if (better) {
        best = { roster: next, winChance, score };
      }
    }
    // Stages go up in swap count, so the first stage to hit the target holds the fewest-swap answer.
    if (best && best.score.newGap <= targetNewGap && onTarget(best.score)) {
      break;
    }
  }

  if (!best) {
    return undefined;
  }
  return {
    roster: [...best.roster].sort((a, b) => a.slot - b.slot),
    winChance: best.winChance,
    balanced: onTarget(best.score),
    newSplit: newPlayerSplit(best.roster),
  };
}
