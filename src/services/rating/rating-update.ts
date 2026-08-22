import type { Prisma } from '@prisma/client';
import { rating, rate, type Rating } from 'openskill';
import { prisma } from '../../lib/prisma.js';
import { MatchServiceError } from '../match/match-service.js';
import {
  ratingEntitiesForHero,
  ratingEntitiesForOverall,
  rosterEntriesWithHeroId,
} from './rating-entities.js';
import { computeLobbyAvgKi, kisForLobbyAverage, scaleAppliedMu } from './lobby-relative-scale.js';
import { displayOrdinal, splitRosterByTeam, toOpenSkillRatings } from './rating-math.js';
import { ensurePlayerRatings } from './rating-preview.js';
import { gamesByPlayerFromStats, loadMatchDisplayStatsByPlayer } from './rank-reset-display.js';

const DEFAULT_MU = 25;
const DEFAULT_SIGMA = 8.333;

/**
 * Peer synthetic losses for quitters.
 * N=1 vs a mirrored team hits display ki harder than a fair match loss;
 * N=3 with a peer dummy is far too severe (~−764 ki at cold start).
 */
export const QUITTER_SYNTHETIC_LOSSES = 1;

export type RatingRosterEntry = {
  playerId: string;
  slot: number;
  team: 1 | 2;
  heroId: number | null;
  isQuitter: boolean;
  isGriefer?: boolean;
  /** Snapshot of New at apply time; missing/false means not New. */
  wasNewPlayer?: boolean;
};

type Db = Prisma.TransactionClient | typeof prisma;

function defaultRatingEntity(): { mu: number; sigma: number } {
  return { mu: DEFAULT_MU, sigma: DEFAULT_SIGMA };
}

function heroKey(playerId: string, heroId: number): string {
  return `${playerId}:${heroId}`;
}

/**
 * Peer opponent for quitter penalties (not persisted).
 * Copies the quitter team's μ/σ so each synthetic loss is an even match —
 * a fixed strong dummy makes the loss "expected" and barely moves public ki.
 */
export function buildDummyOpponentTeam(playerTeam: Rating[]): Rating[] {
  return playerTeam.map((entity) => rating({ mu: entity.mu, sigma: entity.sigma }));
}

/**
 * Run OpenSkill rate() N times: playerTeam loses to a peer dummy each iteration.
 * Returns the updated playerTeam ratings (same length/order).
 */
export function applySyntheticLosses(
  playerTeam: Rating[],
  losses: number = QUITTER_SYNTHETIC_LOSSES,
): Rating[] {
  let current = playerTeam;

  for (let i = 0; i < losses; i += 1) {
    const dummy = buildDummyOpponentTeam(current);
    const [nextPlayerTeam] = rate([current, dummy], { rank: [2, 1] });
    current = nextPlayerTeam ?? current;
  }

  return current;
}

function applyIndependentSyntheticLosses(
  global: { mu: number; sigma: number },
  hero: { mu: number; sigma: number },
  heroId: number | null,
): { global: Rating; hero?: Rating } {
  const [nextGlobal] = applySyntheticLosses(toOpenSkillRatings(ratingEntitiesForOverall(global)));
  if (!nextGlobal) {
    return { global: rating({ mu: global.mu, sigma: global.sigma }) };
  }
  if (heroId == null) {
    return { global: nextGlobal };
  }
  const [nextHero] = applySyntheticLosses(toOpenSkillRatings(ratingEntitiesForHero(hero)));
  return { global: nextGlobal, hero: nextHero };
}

export function partitionRosterForRating<T extends { isQuitter: boolean; wasNewPlayer?: boolean }>(
  entries: T[],
): { quitters: T[]; newNonQuit: T[]; activeRateable: T[] } {
  const quitters = entries.filter((entry) => entry.isQuitter);
  const nonQuit = entries.filter((entry) => !entry.isQuitter);
  return {
    quitters,
    newNonQuit: nonQuit.filter((entry) => entry.wasNewPlayer === true),
    activeRateable: nonQuit.filter((entry) => entry.wasNewPlayer !== true),
  };
}

/** True when both teams have ≥1 player eligible for team OpenSkill rate(). */
export function canRunTeamRate(activeRateable: { team: 1 | 2 }[]): boolean {
  const hasTeamA = activeRateable.some((entry) => entry.team === 1);
  const hasTeamB = activeRateable.some((entry) => entry.team === 2);
  return hasTeamA && hasTeamB;
}

/** True when both teams have ≥1 hero seat eligible for the hero OpenSkill rate(). */
export function canRunHeroRate(activeRateable: { team: 1 | 2; heroId: number | null }[]): boolean {
  const withHero = activeRateable.filter((entry) => entry.heroId != null);
  const hasTeamA = withHero.some((entry) => entry.team === 1);
  const hasTeamB = withHero.some((entry) => entry.team === 2);
  return hasTeamA && hasTeamB;
}

function grieferPenaltyEntries(entries: RatingRosterEntry[]): RatingRosterEntry[] {
  return entries.filter((entry) => entry.isGriefer && !entry.isQuitter);
}

async function applySyntheticPenalties(
  leagueId: string,
  penaltyEntries: RatingRosterEntry[],
  db: Db,
): Promise<void> {
  const sorted = [...penaltyEntries].sort((left, right) => left.slot - right.slot);

  if (sorted.length === 0) {
    return;
  }

  await ensurePlayerRatings(
    leagueId,
    sorted.map((entry) => ({
      playerId: entry.playerId,
      heroId: entry.heroId,
    })),
    db,
  );

  const playerIds = sorted.map((entry) => entry.playerId);
  const withHero = sorted.filter(
    (entry): entry is RatingRosterEntry & { heroId: number } => entry.heroId != null,
  );
  const [globalRatings, heroRatings] = await Promise.all([
    db.playerRating.findMany({
      where: { leagueId, playerId: { in: playerIds } },
    }),
    withHero.length > 0
      ? db.playerHeroRating.findMany({
          where: {
            leagueId,
            OR: withHero.map((entry) => ({
              playerId: entry.playerId,
              heroId: entry.heroId,
            })),
          },
        })
      : Promise.resolve([]),
  ]);

  const globalByPlayer = new Map(globalRatings.map((row) => [row.playerId, row]));
  const heroByKey = new Map(heroRatings.map((row) => [heroKey(row.playerId, row.heroId), row]));

  for (const entry of sorted) {
    const global = globalByPlayer.get(entry.playerId) ?? defaultRatingEntity();
    const hero =
      entry.heroId == null
        ? defaultRatingEntity()
        : (heroByKey.get(heroKey(entry.playerId, entry.heroId)) ?? defaultRatingEntity());
    const updated = applyIndependentSyntheticLosses(global, hero, entry.heroId);
    const nextGlobal = updated.global;

    await db.playerRating.update({
      where: { leagueId_playerId: { leagueId, playerId: entry.playerId } },
      data: {
        mu: nextGlobal.mu,
        sigma: nextGlobal.sigma,
      },
    });

    if (entry.heroId == null || !updated.hero) {
      continue;
    }

    await db.playerHeroRating.update({
      where: {
        leagueId_playerId_heroId: {
          leagueId,
          playerId: entry.playerId,
          heroId: entry.heroId,
        },
      },
      data: {
        mu: updated.hero.mu,
        sigma: updated.hero.sigma,
      },
    });
  }
}

export function assertBothTeamsHaveActivePlayers(active: { slot: number; team: 1 | 2 }[]): void {
  const { teamA, teamB } = splitRosterByTeam(active);

  if (teamA.length === 0 || teamB.length === 0) {
    throw new MatchServiceError(
      'Cannot complete: after quitters, a team has no remaining players. Cancel the match instead.',
    );
  }
}

export async function applyQuitterPenalties(
  leagueId: string,
  entries: RatingRosterEntry[],
  db: Db = prisma,
): Promise<void> {
  const sorted = [...entries].sort((left, right) => left.slot - right.slot);
  const { quitters } = partitionRosterForRating(sorted);
  await applySyntheticPenalties(leagueId, quitters, db);
}

export async function applyGrieferPenalties(
  leagueId: string,
  entries: RatingRosterEntry[],
  db: Db = prisma,
): Promise<void> {
  const sorted = [...entries].sort((left, right) => left.slot - right.slot);
  await applySyntheticPenalties(leagueId, grieferPenaltyEntries(sorted), db);
}

type UpdatedPlayerRating = {
  global: Rating;
  hero?: Rating;
  heroId: number | null;
};

function snapshotPreMatchMuSigma(
  active: RatingRosterEntry[],
  globalByPlayer: Map<string, MuSigma>,
  heroByKey: Map<string, MuSigma>,
): { preGlobal: Map<string, MuSigma>; preHero: Map<string, MuSigma> } {
  const preGlobal = new Map<string, MuSigma>();
  const preHero = new Map<string, MuSigma>();

  for (const entry of active) {
    const global = globalByPlayer.get(entry.playerId) ?? defaultRatingEntity();
    preGlobal.set(entry.playerId, { mu: global.mu, sigma: global.sigma });

    if (entry.heroId == null) {
      continue;
    }

    const hero = heroByKey.get(heroKey(entry.playerId, entry.heroId)) ?? defaultRatingEntity();
    preHero.set(heroKey(entry.playerId, entry.heroId), {
      mu: hero.mu,
      sigma: hero.sigma,
    });
  }

  return { preGlobal, preHero };
}

/**
 * Scale OpenSkill μ deltas by each player's offset from lobby-average global ki.
 * Lobby average uses calibrated players only (< 5 games excluded); if the
 * whole lobby is still calibrating, falls back to every active human.
 * Mutates `updatedByPlayer` in place; σ is unchanged.
 */
function applyLobbyRelativeScalingToResults(
  active: RatingRosterEntry[],
  winningTeam: 1 | 2,
  preGlobal: Map<string, MuSigma>,
  preHero: Map<string, MuSigma>,
  updatedByPlayer: Map<string, UpdatedPlayerRating>,
  globalGamesByPlayer: Map<string, number>,
): void {
  const prePlayers: Array<{ ki: number; games: number }> = [];
  const preKiByPlayer = new Map<string, number>();

  for (const entry of active) {
    const before = preGlobal.get(entry.playerId);
    if (!before) {
      continue;
    }
    const games = globalGamesByPlayer.get(entry.playerId) ?? 0;
    const ki = displayOrdinal(before.mu, before.sigma, games);
    preKiByPlayer.set(entry.playerId, ki);
    prePlayers.push({ ki, games });
  }

  const lobbyAvg = computeLobbyAvgKi(kisForLobbyAverage(prePlayers));

  for (const entry of active) {
    const beforeGlobal = preGlobal.get(entry.playerId);
    const updated = updatedByPlayer.get(entry.playerId);
    if (!beforeGlobal || !updated) {
      continue;
    }

    const playerKi = preKiByPlayer.get(entry.playerId) ?? lobbyAvg;
    const offsetKi = playerKi - lobbyAvg;
    const won = entry.team === winningTeam;

    const scaledGlobalMu = scaleAppliedMu(beforeGlobal.mu, updated.global.mu, won, offsetKi);
    updated.global = rating({ mu: scaledGlobalMu, sigma: updated.global.sigma });

    if (entry.heroId == null || !updated.hero) {
      continue;
    }

    const heroBefore = preHero.get(heroKey(entry.playerId, entry.heroId)) ?? defaultRatingEntity();
    const scaledHeroMu = scaleAppliedMu(heroBefore.mu, updated.hero.mu, won, offsetKi);
    updated.hero = rating({ mu: scaledHeroMu, sigma: updated.hero.sigma });
  }
}

function buildOverallTeamEntities(
  team: RatingRosterEntry[],
  globalByPlayer: Map<string, { mu: number; sigma: number }>,
): Rating[] {
  return toOpenSkillRatings(
    team.flatMap((entry) => {
      const global = globalByPlayer.get(entry.playerId) ?? defaultRatingEntity();
      return ratingEntitiesForOverall(global);
    }),
  );
}

function buildHeroTeamEntities(
  team: RatingRosterEntry[],
  heroByKey: Map<string, { mu: number; sigma: number }>,
): Rating[] {
  return toOpenSkillRatings(
    rosterEntriesWithHeroId(team).flatMap((entry) => {
      const hero = heroByKey.get(heroKey(entry.playerId, entry.heroId)) ?? defaultRatingEntity();
      return ratingEntitiesForHero(hero);
    }),
  );
}

function rateActiveMatchTeams(
  activeRateable: RatingRosterEntry[],
  winningTeam: 1 | 2,
  globalByPlayer: Map<string, MuSigma>,
  heroByKey: Map<string, MuSigma>,
  globalGamesByPlayer: Map<string, number>,
): Map<string, UpdatedPlayerRating> {
  const { teamA, teamB } = splitRosterByTeam(activeRateable);
  const winningRoster = winningTeam === 1 ? teamA : teamB;
  const losingRoster = winningTeam === 1 ? teamB : teamA;
  const { preGlobal, preHero } = snapshotPreMatchMuSigma(activeRateable, globalByPlayer, heroByKey);

  const [updatedWinningOverall, updatedLosingOverall] = rate(
    [
      buildOverallTeamEntities(winningRoster, globalByPlayer),
      buildOverallTeamEntities(losingRoster, globalByPlayer),
    ],
    { rank: [1, 2] },
  );

  const updatedByPlayer = new Map<string, UpdatedPlayerRating>();

  const registerOverall = (team: RatingRosterEntry[], ratings: Rating[]): void => {
    for (const [index, entry] of team.entries()) {
      const global = ratings[index];
      if (!global) {
        continue;
      }
      updatedByPlayer.set(entry.playerId, {
        global,
        heroId: entry.heroId,
      });
    }
  };

  registerOverall(winningRoster, updatedWinningOverall);
  registerOverall(losingRoster, updatedLosingOverall);

  if (canRunHeroRate(activeRateable)) {
    const winningHeroRoster = rosterEntriesWithHeroId(winningRoster);
    const losingHeroRoster = rosterEntriesWithHeroId(losingRoster);
    const [updatedWinningHero, updatedLosingHero] = rate(
      [
        buildHeroTeamEntities(winningRoster, heroByKey),
        buildHeroTeamEntities(losingRoster, heroByKey),
      ],
      { rank: [1, 2] },
    );

    const registerHero = (
      team: Array<RatingRosterEntry & { heroId: number }>,
      ratings: Rating[],
    ): void => {
      for (const [index, entry] of team.entries()) {
        const hero = ratings[index];
        const updated = updatedByPlayer.get(entry.playerId);
        if (!updated || !hero) {
          continue;
        }
        updated.hero = hero;
      }
    };

    registerHero(winningHeroRoster, updatedWinningHero);
    registerHero(losingHeroRoster, updatedLosingHero);
  }

  applyLobbyRelativeScalingToResults(
    activeRateable,
    winningTeam,
    preGlobal,
    preHero,
    updatedByPlayer,
    globalGamesByPlayer,
  );

  return updatedByPlayer;
}

export async function applyMatchRatings(
  leagueId: string,
  entries: RatingRosterEntry[],
  winningTeam: 1 | 2,
  db: Db = prisma,
): Promise<void> {
  const sorted = [...entries].sort((left, right) => left.slot - right.slot);
  const { activeRateable } = partitionRosterForRating(sorted);

  if (!canRunTeamRate(activeRateable)) {
    return;
  }

  await ensurePlayerRatings(
    leagueId,
    activeRateable.map((entry) => ({
      playerId: entry.playerId,
      heroId: entry.heroId,
    })),
    db,
  );

  const playerIds = activeRateable.map((entry) => entry.playerId);
  const withHero = activeRateable.filter(
    (entry): entry is RatingRosterEntry & { heroId: number } => entry.heroId != null,
  );
  const [globalRatings, heroRatings] = await Promise.all([
    db.playerRating.findMany({
      where: { leagueId, playerId: { in: playerIds } },
    }),
    withHero.length > 0
      ? db.playerHeroRating.findMany({
          where: {
            leagueId,
            OR: withHero.map((entry) => ({
              playerId: entry.playerId,
              heroId: entry.heroId,
            })),
          },
        })
      : Promise.resolve([]),
  ]);

  const globalByPlayer = new Map(globalRatings.map((row) => [row.playerId, row]));
  const heroByKey = new Map(heroRatings.map((row) => [heroKey(row.playerId, row.heroId), row]));

  const displayStats = await loadMatchDisplayStatsByPlayer(leagueId, playerIds, db);
  const globalGamesByPlayer = gamesByPlayerFromStats(displayStats);
  const updatedByPlayer = rateActiveMatchTeams(
    activeRateable,
    winningTeam,
    globalByPlayer,
    heroByKey,
    globalGamesByPlayer,
  );

  for (const entry of activeRateable) {
    const updated = updatedByPlayer.get(entry.playerId);

    if (!updated) {
      continue;
    }

    await db.playerRating.update({
      where: { leagueId_playerId: { leagueId, playerId: entry.playerId } },
      data: {
        mu: updated.global.mu,
        sigma: updated.global.sigma,
      },
    });

    if (entry.heroId == null || !updated.hero) {
      continue;
    }

    await db.playerHeroRating.update({
      where: {
        leagueId_playerId_heroId: {
          leagueId,
          playerId: entry.playerId,
          heroId: entry.heroId,
        },
      },
      data: {
        mu: updated.hero.mu,
        sigma: updated.hero.sigma,
        matchesPlayed: { increment: 1 },
      },
    });
  }
}

export type MuSigma = { mu: number; sigma: number };

/**
 * Pure in-memory OpenSkill apply (quitters then match) from starting μ/σ maps.
 * Used to rebuild completed-match ki deltas from pre-match snapshots without DB writes.
 */
export function simulatePostMatchRatings(
  entries: RatingRosterEntry[],
  winningTeam: 1 | 2,
  startingGlobal: Map<string, MuSigma>,
  startingHero: Map<string, MuSigma>,
  globalGamesByPlayer: Map<string, number> = new Map(),
): { globalByPlayer: Map<string, MuSigma>; heroByKey: Map<string, MuSigma> } {
  const globalByPlayer = new Map(startingGlobal);
  const heroByKey = new Map(startingHero);
  const sorted = [...entries].sort((left, right) => left.slot - right.slot);
  const { quitters, activeRateable } = partitionRosterForRating(sorted);

  for (const entry of quitters) {
    const global = globalByPlayer.get(entry.playerId) ?? defaultRatingEntity();
    const hero =
      entry.heroId == null
        ? defaultRatingEntity()
        : (heroByKey.get(heroKey(entry.playerId, entry.heroId)) ?? defaultRatingEntity());
    const updated = applyIndependentSyntheticLosses(global, hero, entry.heroId);
    globalByPlayer.set(entry.playerId, { mu: updated.global.mu, sigma: updated.global.sigma });
    if (entry.heroId != null && updated.hero) {
      heroByKey.set(heroKey(entry.playerId, entry.heroId), {
        mu: updated.hero.mu,
        sigma: updated.hero.sigma,
      });
    }
  }

  for (const entry of grieferPenaltyEntries(sorted)) {
    const global = globalByPlayer.get(entry.playerId) ?? defaultRatingEntity();
    const hero =
      entry.heroId == null
        ? defaultRatingEntity()
        : (heroByKey.get(heroKey(entry.playerId, entry.heroId)) ?? defaultRatingEntity());
    const updated = applyIndependentSyntheticLosses(global, hero, entry.heroId);
    globalByPlayer.set(entry.playerId, { mu: updated.global.mu, sigma: updated.global.sigma });
    if (entry.heroId != null && updated.hero) {
      heroByKey.set(heroKey(entry.playerId, entry.heroId), {
        mu: updated.hero.mu,
        sigma: updated.hero.sigma,
      });
    }
  }

  if (!canRunTeamRate(activeRateable)) {
    return { globalByPlayer, heroByKey };
  }

  const updatedByPlayer = rateActiveMatchTeams(
    activeRateable,
    winningTeam,
    globalByPlayer,
    heroByKey,
    globalGamesByPlayer,
  );

  for (const entry of activeRateable) {
    const updated = updatedByPlayer.get(entry.playerId);
    if (!updated) {
      continue;
    }
    globalByPlayer.set(entry.playerId, {
      mu: updated.global.mu,
      sigma: updated.global.sigma,
    });
    if (entry.heroId != null && updated.hero) {
      heroByKey.set(heroKey(entry.playerId, entry.heroId), {
        mu: updated.hero.mu,
        sigma: updated.hero.sigma,
      });
    }
  }

  return { globalByPlayer, heroByKey };
}
