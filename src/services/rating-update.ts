import type { Prisma } from '@prisma/client';
import { rating, rate, type Rating } from 'openskill';
import { prisma } from '../lib/prisma.js';
import { MatchServiceError } from './match-service.js';
import { ensureHeroesExist, ensurePlayerRatings } from './rating-preview.js';
import { splitRosterByTeam, toOpenSkillRatings } from './rating-math.js';

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
  heroId: number;
  isQuitter: boolean;
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

export function partitionRosterForRating<T extends { isQuitter: boolean }>(
  entries: T[],
): { quitters: T[]; active: T[] } {
  return {
    quitters: entries.filter((entry) => entry.isQuitter),
    active: entries.filter((entry) => !entry.isQuitter),
  };
}

export function assertBothTeamsHaveActivePlayers(active: { slot: number }[]): void {
  const { teamA, teamB } = splitRosterByTeam(active);

  if (teamA.length === 0 || teamB.length === 0) {
    throw new MatchServiceError(
      'Cannot complete: after quitters, a team has no remaining players. Cancel the match instead.',
    );
  }
}

export async function applyQuitterPenalties(
  entries: RatingRosterEntry[],
  db: Db = prisma,
): Promise<void> {
  const sorted = [...entries].sort((left, right) => left.slot - right.slot);
  const { quitters } = partitionRosterForRating(sorted);

  if (quitters.length === 0) {
    return;
  }

  await ensureHeroesExist();
  await ensurePlayerRatings(
    quitters.map((entry) => ({
      playerId: entry.playerId,
      heroId: entry.heroId,
    })),
    db,
  );

  const playerIds = quitters.map((entry) => entry.playerId);
  const [globalRatings, heroRatings] = await Promise.all([
    db.playerRating.findMany({
      where: { playerId: { in: playerIds } },
    }),
    db.playerHeroRating.findMany({
      where: {
        OR: quitters.map((entry) => ({
          playerId: entry.playerId,
          heroId: entry.heroId,
        })),
      },
    }),
  ]);

  const globalByPlayer = new Map(globalRatings.map((row) => [row.playerId, row]));
  const heroByKey = new Map(
    heroRatings.map((row) => [heroKey(row.playerId, row.heroId), row]),
  );

  for (const entry of quitters) {
    const global = globalByPlayer.get(entry.playerId) ?? defaultRatingEntity();
    const hero =
      heroByKey.get(heroKey(entry.playerId, entry.heroId)) ?? defaultRatingEntity();
    const [nextGlobal, nextHero] = applySyntheticLosses(toOpenSkillRatings([global, hero]));

    await db.playerRating.update({
      where: { playerId: entry.playerId },
      data: {
        mu: nextGlobal.mu,
        sigma: nextGlobal.sigma,
      },
    });

    await db.playerHeroRating.update({
      where: {
        playerId_heroId: {
          playerId: entry.playerId,
          heroId: entry.heroId,
        },
      },
      data: {
        mu: nextHero.mu,
        sigma: nextHero.sigma,
      },
    });
  }
}

function buildTeamEntities(
  team: RatingRosterEntry[],
  globalByPlayer: Map<string, { mu: number; sigma: number }>,
  heroByKey: Map<string, { mu: number; sigma: number }>,
): Rating[] {
  return toOpenSkillRatings(
    team.flatMap((entry) => {
      const global = globalByPlayer.get(entry.playerId) ?? defaultRatingEntity();
      const hero =
        heroByKey.get(heroKey(entry.playerId, entry.heroId)) ?? defaultRatingEntity();

      return [global, hero];
    }),
  );
}

export async function applyMatchRatings(
  entries: RatingRosterEntry[],
  winningTeam: 1 | 2,
  db: Db = prisma,
): Promise<void> {
  const sorted = [...entries].sort((left, right) => left.slot - right.slot);
  const { active } = partitionRosterForRating(sorted);

  assertBothTeamsHaveActivePlayers(active);

  await ensureHeroesExist();
  await ensurePlayerRatings(
    active.map((entry) => ({
      playerId: entry.playerId,
      heroId: entry.heroId,
    })),
    db,
  );

  const playerIds = active.map((entry) => entry.playerId);
  const [globalRatings, heroRatings] = await Promise.all([
    db.playerRating.findMany({
      where: { playerId: { in: playerIds } },
    }),
    db.playerHeroRating.findMany({
      where: {
        OR: active.map((entry) => ({
          playerId: entry.playerId,
          heroId: entry.heroId,
        })),
      },
    }),
  ]);

  const globalByPlayer = new Map(globalRatings.map((row) => [row.playerId, row]));
  const heroByKey = new Map(
    heroRatings.map((row) => [heroKey(row.playerId, row.heroId), row]),
  );

  const { teamA, teamB } = splitRosterByTeam(active);
  const winningRoster = winningTeam === 1 ? teamA : teamB;
  const losingRoster = winningTeam === 1 ? teamB : teamA;

  const [updatedWinningTeam, updatedLosingTeam] = rate(
    [
      buildTeamEntities(winningRoster, globalByPlayer, heroByKey),
      buildTeamEntities(losingRoster, globalByPlayer, heroByKey),
    ],
    { rank: [1, 2] },
  );

  const updatedByPlayer = new Map<
    string,
    { global: Rating; hero: Rating; heroId: number }
  >();

  const registerTeam = (team: RatingRosterEntry[], ratings: Rating[]): void => {
    team.forEach((entry, index) => {
      const global = ratings[index * 2];
      const hero = ratings[index * 2 + 1];

      if (!global || !hero) {
        return;
      }

      updatedByPlayer.set(entry.playerId, {
        global,
        hero,
        heroId: entry.heroId,
      });
    });
  };

  registerTeam(winningRoster, updatedWinningTeam);
  registerTeam(losingRoster, updatedLosingTeam);

  for (const entry of active) {
    const updated = updatedByPlayer.get(entry.playerId);

    if (!updated) {
      continue;
    }

    await db.playerRating.update({
      where: { playerId: entry.playerId },
      data: {
        mu: updated.global.mu,
        sigma: updated.global.sigma,
      },
    });

    await db.playerHeroRating.update({
      where: {
        playerId_heroId: {
          playerId: entry.playerId,
          heroId: updated.heroId,
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
