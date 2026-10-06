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
import { classifyNewSeatsForBalance, entryPairKey } from '../rating/new-player-partition.js';
import { roundWinPercents, splitRosterByTeam, toOpenSkillRatings } from '../rating/rating-math.js';

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

/** Max rounded imbalance (|50 − teamA%|) that counts as balanced: 50/50 or 51/49. */
export const BALANCE_TARGET_IMBALANCE = 1;

/** Random placements tried per Balance click before settling for the closest one. */
// ponytail: random sampling, not exhaustive search; raise if 49–51 is often missed on solvable lobbies.
const BALANCE_ATTEMPTS = 3000;

export type BalanceResult = {
  roster: BalanceRosterEntry[];
  winChance: { teamAPercent: number; teamBPercent: number };
  /** True when the result is within {@link BALANCE_TARGET_IMBALANCE}. */
  balanced: boolean;
};

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

/**
 * Re-seat unlocked players across all non-locked slots (occupied or empty) so
 * win chance lands at 50/50 or 51/49. Locked seats never move. Random search,
 * so repeated calls return different balanced seatings; the current seating is
 * never returned. Falls back to the closest seating found that is no worse than
 * the current one. Returns undefined when nothing can be moved or improved.
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

  const currentKey = seatingKey(roster);
  const current = winChanceForRoster(roster, lookup, options);
  let bestImbalance = current ? imbalance(current.teamAPercent) : Number.POSITIVE_INFINITY;
  let best: Omit<BalanceResult, 'balanced'> | undefined;

  for (let attempt = 0; attempt < BALANCE_ATTEMPTS; attempt += 1) {
    fisherYatesInPlace(openSlots, random);
    const next = [
      ...fixed,
      ...movers.map((entry, index) => {
        const slot = openSlots[index]!;
        return swappedSeat(entry, slot, teamForSlot(resolved, slot), resolved);
      }),
    ];
    if (seatingKey(next) === currentKey) {
      continue;
    }
    const winChance = winChanceForRoster(next, lookup, options);
    if (!winChance || imbalance(winChance.teamAPercent) > bestImbalance) {
      continue;
    }
    if (best && imbalance(winChance.teamAPercent) === bestImbalance) {
      continue;
    }
    bestImbalance = imbalance(winChance.teamAPercent);
    best = { roster: next, winChance };
    if (bestImbalance <= BALANCE_TARGET_IMBALANCE) {
      break;
    }
  }

  if (!best) {
    return undefined;
  }
  return {
    roster: [...best.roster].sort((a, b) => a.slot - b.slot),
    winChance: best.winChance,
    balanced: bestImbalance <= BALANCE_TARGET_IMBALANCE,
  };
}
