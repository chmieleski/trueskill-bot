import { predictWin } from 'openskill';
import { prisma } from '../lib/prisma.js';
import { createLogger } from '../lib/logger.js';
import {
  displayOrdinal,
  roundWinPercents,
  splitRosterByTeam,
  toOpenSkillRatings,
} from './rating-math.js';

const log = createLogger('rating-preview');

const DEFAULT_MU = 25;
const DEFAULT_SIGMA = 8.333;

export interface LobbyRatingPlayerLine {
  slot: number;
  nick: string;
  globalOrdinal: number;
  heroOrdinal: number;
}

export interface LobbyRatingPreview {
  players: LobbyRatingPlayerLine[];
  /** Present only when both teams have ≥1 human. */
  winChance?: {
    teamAPercent: number;
    teamBPercent: number;
  };
}

export type RatingPreviewRosterEntry = {
  playerId: string;
  slot: number;
  heroId: number;
  nick: string;
};

/** Process-lifetime cache so we only seed Hero 1–12 once. */
let heroesEnsurePromise: Promise<void> | null = null;

/** Ensure Hero rows 1–12 exist (FK for PlayerHeroRating). Cached per process. */
export async function ensureHeroesExist(): Promise<void> {
  if (!heroesEnsurePromise) {
    heroesEnsurePromise = prisma.hero
      .createMany({
        data: Array.from({ length: 12 }, (_, index) => ({
          id: index + 1,
          name: `Hero ${index + 1}`,
        })),
        skipDuplicates: true,
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        heroesEnsurePromise = null;
        throw error;
      });
  }

  await heroesEnsurePromise;
}

/**
 * Batch cold-start for missing global + hero ratings (few round-trips).
 */
export async function ensurePlayerRatings(
  entries: RatingPreviewRosterEntry[],
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  await prisma.playerRating.createMany({
    data: entries.map((entry) => ({ playerId: entry.playerId })),
    skipDuplicates: true,
  });

  await prisma.playerHeroRating.createMany({
    data: entries.map((entry) => ({
      playerId: entry.playerId,
      heroId: entry.heroId,
    })),
    skipDuplicates: true,
  });
}

function defaultMuSigma(): { mu: number; sigma: number } {
  return { mu: DEFAULT_MU, sigma: DEFAULT_SIGMA };
}

/**
 * Load ordinals + win chance for the current lobby roster.
 * Read-only prediction: never calls rate().
 * On failure, returns default ordinals and omits winChance.
 */
export async function loadLobbyRatingPreview(
  entries: RatingPreviewRosterEntry[],
): Promise<LobbyRatingPreview> {
  const sorted = [...entries].sort((a, b) => a.slot - b.slot);

  if (sorted.length === 0) {
    return { players: [] };
  }

  try {
    await ensureHeroesExist();
    await ensurePlayerRatings(sorted);

    const playerIds = sorted.map((entry) => entry.playerId);
    const [globals, heroes] = await Promise.all([
      prisma.playerRating.findMany({
        where: { playerId: { in: playerIds } },
      }),
      prisma.playerHeroRating.findMany({
        where: {
          OR: sorted.map((entry) => ({
            playerId: entry.playerId,
            heroId: entry.heroId,
          })),
        },
      }),
    ]);

    const globalByPlayer = new Map(globals.map((row) => [row.playerId, row]));
    const heroKey = (playerId: string, heroId: number) => `${playerId}:${heroId}`;
    const heroByKey = new Map(
      heroes.map((row) => [heroKey(row.playerId, row.heroId), row]),
    );

    const players: LobbyRatingPlayerLine[] = sorted.map((entry) => {
      const global = globalByPlayer.get(entry.playerId) ?? defaultMuSigma();
      const hero =
        heroByKey.get(heroKey(entry.playerId, entry.heroId)) ?? defaultMuSigma();
      return {
        slot: entry.slot,
        nick: entry.nick,
        globalOrdinal: displayOrdinal(global.mu, global.sigma),
        heroOrdinal: displayOrdinal(hero.mu, hero.sigma),
      };
    });

    const { teamA, teamB } = splitRosterByTeam(sorted);
    if (teamA.length === 0 || teamB.length === 0) {
      return { players };
    }

    const teamEntities = (team: RatingPreviewRosterEntry[]) => {
      const entities: { mu: number; sigma: number }[] = [];
      for (const entry of team) {
        const global = globalByPlayer.get(entry.playerId) ?? defaultMuSigma();
        const hero =
          heroByKey.get(heroKey(entry.playerId, entry.heroId)) ?? defaultMuSigma();
        entities.push(
          { mu: global.mu, sigma: global.sigma },
          { mu: hero.mu, sigma: hero.sigma },
        );
      }
      return toOpenSkillRatings(entities);
    };

    const [pA, pB] = predictWin([teamEntities(teamA), teamEntities(teamB)]);
    return {
      players,
      winChance: roundWinPercents(pA ?? 0.5, pB ?? 0.5),
    };
  } catch (error) {
    log.error({ err: error }, 'Failed to load lobby rating preview');
    return {
      players: sorted.map((entry) => ({
        slot: entry.slot,
        nick: entry.nick,
        globalOrdinal: displayOrdinal(DEFAULT_MU, DEFAULT_SIGMA),
        heroOrdinal: displayOrdinal(DEFAULT_MU, DEFAULT_SIGMA),
      })),
    };
  }
}

/** Map MatchWithPlayers rows into preview roster entries. */
export function matchPlayersToRatingEntries(
  matchPlayers: {
    playerId: string;
    slot: number;
    heroId: number;
    player: { username: string };
  }[],
): RatingPreviewRosterEntry[] {
  return matchPlayers.map((entry) => ({
    playerId: entry.playerId,
    slot: entry.slot,
    heroId: entry.heroId,
    nick: entry.player.username,
  }));
}
