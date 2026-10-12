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
  /** Fewer than 5 completed league games; Balance splits these evenly, separately from New. */
  calibrating?: boolean;
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
    ...(source.calibrating === true ? { calibrating: true as const } : {}),
  };
}

/** Max rounded imbalance (|50 − teamA%|) that counts as balanced: 50/50 or 51/49. */
export const BALANCE_TARGET_IMBALANCE = 1;

/** Random placements tried per Balance click before settling for the closest one. */
// ponytail: random sampling, not exhaustive search; raise if 49–51 is often missed on solvable lobbies.
const BALANCE_ATTEMPTS = 3000;

/** Seats per team for a group; `even` = gap is the minimum the count allows (0 even, 1 odd). */
export type NewPlayerSplit = { team1: number; team2: number; even: boolean };

export type BalanceResult = {
  roster: BalanceRosterEntry[];
  winChance: { teamAPercent: number; teamBPercent: number };
  /** True when the result is within {@link BALANCE_TARGET_IMBALANCE}. */
  balanced: boolean;
  /** Only uneven when locked seats force it. */
  newSplit: NewPlayerSplit;
  /** Calibrating seats that are not New; only uneven when locked seats force it. */
  calibratingSplit: NewPlayerSplit;
};

function isCalibratingSeat(entry: BalanceRosterEntry): boolean {
  return entry.calibrating === true && !isMarkedNewPlayer(entry);
}

function groupSplit(
  roster: BalanceRosterEntry[],
  inGroup: (entry: BalanceRosterEntry) => boolean,
): NewPlayerSplit {
  let team1 = 0;
  let team2 = 0;
  for (const entry of roster) {
    if (!inGroup(entry)) {
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

const newPlayerSplit = (roster: BalanceRosterEntry[]) => groupSplit(roster, isMarkedNewPlayer);
const calibratingSplit = (roster: BalanceRosterEntry[]) => groupSplit(roster, isCalibratingSeat);

function splitGap(split: NewPlayerSplit): number {
  return Math.abs(split.team1 - split.team2);
}

/** Seating rank: New-player gap, then calibrating gap, then win% imbalance. Lower is better. */
type SeatingScore = { newGap: number; calibratingGap: number; imbalance: number };

function compareScores(left: SeatingScore, right: SeatingScore): number {
  return (
    left.newGap - right.newGap ||
    left.calibratingGap - right.calibratingGap ||
    left.imbalance - right.imbalance
  );
}

function scoreSeating(
  roster: BalanceRosterEntry[],
  winChance: { teamAPercent: number } | undefined,
): SeatingScore {
  return {
    newGap: splitGap(newPlayerSplit(roster)),
    calibratingGap: splitGap(calibratingSplit(roster)),
    imbalance: winChance ? imbalance(winChance.teamAPercent) : Number.POSITIVE_INFINITY,
  };
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

/**
 * Re-seat unlocked players across all non-locked slots (occupied or empty) so
 * New players split evenly (half each side; odd counts within one), then
 * calibrating players (not New) split evenly on their own, and, among those seatings,
 * win chance lands at 50/50 or 51/49. An even split always beats a better win%; only locked seats can leave it uneven. Locked seats never move. Random search,
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
  const currentSplit = newPlayerSplit(roster);
  const targetNewGap = (currentSplit.team1 + currentSplit.team2) % 2;
  const currentCalibrating = calibratingSplit(roster);
  const targetCalibratingGap = (currentCalibrating.team1 + currentCalibrating.team2) % 2;
  let bestScore = scoreSeating(roster, winChanceForRoster(roster, lookup, options));
  let best: Pick<BalanceResult, 'roster' | 'winChance'> | undefined;

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
    if (!winChance) {
      continue;
    }
    const score = scoreSeating(next, winChance);
    // First pick may tie the current seating; later picks must strictly improve.
    const order = compareScores(score, bestScore);
    if (order > 0 || (best && order === 0)) {
      continue;
    }
    bestScore = score;
    best = { roster: next, winChance };
    if (
      score.newGap <= targetNewGap &&
      score.calibratingGap <= targetCalibratingGap &&
      score.imbalance <= BALANCE_TARGET_IMBALANCE
    ) {
      break;
    }
  }

  if (!best) {
    return undefined;
  }
  return {
    roster: [...best.roster].sort((a, b) => a.slot - b.slot),
    winChance: best.winChance,
    balanced: bestScore.imbalance <= BALANCE_TARGET_IMBALANCE,
    newSplit: newPlayerSplit(best.roster),
    calibratingSplit: calibratingSplit(best.roster),
  };
}
