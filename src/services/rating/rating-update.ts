import type { Prisma } from '@prisma/client';
import { rating, rate, type Rating } from 'openskill';
import { prisma } from '../../lib/prisma.js';
import { MatchServiceError } from '../match/match-service.js';
import { ratingEntitiesForPlayer } from './rating-entities.js';
import { ensurePlayerRatings } from './rating-preview.js';
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
  team: 1 | 2;
  heroId: number | null;
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

export function assertBothTeamsHaveActivePlayers(
  active: { slot: number; team: 1 | 2 }[],
): void {
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

  if (quitters.length === 0) {
    return;
  }

  await ensurePlayerRatings(
    leagueId,
    quitters.map((entry) => ({
      playerId: entry.playerId,
      heroId: entry.heroId,
    })),
    db,
  );

  const playerIds = quitters.map((entry) => entry.playerId);
  const withHero = quitters.filter(
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
  const heroByKey = new Map(
    heroRatings.map((row) => [heroKey(row.playerId, row.heroId), row]),
  );

  for (const entry of quitters) {
    const global = globalByPlayer.get(entry.playerId) ?? defaultRatingEntity();
    const hero =
      entry.heroId == null
        ? defaultRatingEntity()
        : heroByKey.get(heroKey(entry.playerId, entry.heroId)) ?? defaultRatingEntity();
    const updated = applySyntheticLosses(
      toOpenSkillRatings(ratingEntitiesForPlayer(global, hero, entry.heroId)),
    );
    const nextGlobal = updated[0];

    if (!nextGlobal) {
      continue;
    }

    await db.playerRating.update({
      where: { leagueId_playerId: { leagueId, playerId: entry.playerId } },
      data: {
        mu: nextGlobal.mu,
        sigma: nextGlobal.sigma,
      },
    });

    if (entry.heroId == null) {
      continue;
    }

    const nextHero = updated[1];
    if (!nextHero) {
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
        entry.heroId == null
          ? defaultRatingEntity()
          : heroByKey.get(heroKey(entry.playerId, entry.heroId)) ?? defaultRatingEntity();

      return ratingEntitiesForPlayer(global, hero, entry.heroId);
    }),
  );
}

export async function applyMatchRatings(
  leagueId: string,
  entries: RatingRosterEntry[],
  winningTeam: 1 | 2,
  db: Db = prisma,
): Promise<void> {
  const sorted = [...entries].sort((left, right) => left.slot - right.slot);
  const { active } = partitionRosterForRating(sorted);

  assertBothTeamsHaveActivePlayers(active);

  await ensurePlayerRatings(
    leagueId,
    active.map((entry) => ({
      playerId: entry.playerId,
      heroId: entry.heroId,
    })),
    db,
  );

  const playerIds = active.map((entry) => entry.playerId);
  const withHero = active.filter(
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
    { global: Rating; hero?: Rating; heroId: number | null }
  >();

  const registerTeam = (team: RatingRosterEntry[], ratings: Rating[]): void => {
    let offset = 0;
    for (const entry of team) {
      const stride = entry.heroId == null ? 1 : 2;
      const global = ratings[offset];
      const hero = stride === 2 ? ratings[offset + 1] : undefined;
      offset += stride;

      if (!global) {
        continue;
      }
      if (stride === 2 && !hero) {
        continue;
      }

      updatedByPlayer.set(entry.playerId, {
        global,
        hero,
        heroId: entry.heroId,
      });
    }
  };

  registerTeam(winningRoster, updatedWinningTeam);
  registerTeam(losingRoster, updatedLosingTeam);

  for (const entry of active) {
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
