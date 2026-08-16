import type { Prisma } from '@prisma/client';
import { MatchResult, MatchStatus } from '@prisma/client';
import { predictWin } from 'openskill';
import { listCatalogHeroIds } from '../guild/hero-catalog.js';
import { prisma } from '../../lib/prisma.js';
import { createLogger } from '../../lib/logger.js';
import { ratingEntitiesForPlayer, rosterEntriesWithHeroId } from './rating-entities.js';
import {
  displayOrdinal,
  roundWinPercents,
  splitRosterByTeam,
  toOpenSkillRatings,
} from './rating-math.js';
import {
  isUnbalancedWinChance,
  suggestBalanceMove,
  type BalanceRatingLookup,
  type BalanceSuggestion,
} from '../lobby/lobby-balance.js';

export type { BalanceSuggestion };

const log = createLogger('rating-preview');

const DEFAULT_MU = 25;
const DEFAULT_SIGMA = 8.333;

export interface LobbyRatingPlayerLine {
  slot: number;
  nick: string;
  /** Display ki (OFFSET + SCALE × (μ − z·σ)); field name kept for DTO stability. */
  globalOrdinal: number;
  /** Display ki for the slot's hero. */
  heroOrdinal: number;
  /** Completed-match only: ki change for global (after − before). */
  globalDelta?: number;
  /** Completed-match only: ki change for hero (after − before). */
  heroDelta?: number;
  isQuitter?: boolean;
}

export interface LobbyRatingPreview {
  players: LobbyRatingPlayerLine[];
  /** Present only when both teams have ≥1 human. */
  winChance?: {
    teamAPercent: number;
    teamBPercent: number;
  };
  balanceSuggestion?: BalanceSuggestion;
}

export type RatingPreviewRosterEntry = {
  playerId: string;
  slot: number;
  team: 1 | 2;
  heroId: number | null;
  nick: string;
  isQuitter?: boolean;
};

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Batch cold-start for missing global ratings, plus hero ratings only when
 * `heroId` is set. Accepts optional transaction client for match completion.
 */
export async function ensurePlayerRatings(
  leagueId: string,
  entries: Pick<RatingPreviewRosterEntry, 'playerId' | 'heroId'>[],
  db: Db = prisma,
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  await db.playerRating.createMany({
    data: entries.map((entry) => ({ leagueId, playerId: entry.playerId })),
    skipDuplicates: true,
  });

  const withHero = rosterEntriesWithHeroId(entries);
  if (withHero.length > 0) {
    await db.playerHeroRating.createMany({
      data: withHero.map((entry) => ({
        leagueId,
        playerId: entry.playerId,
        heroId: entry.heroId,
      })),
      skipDuplicates: true,
    });
  }
}

function defaultMuSigma(): { mu: number; sigma: number } {
  return { mu: DEFAULT_MU, sigma: DEFAULT_SIGMA };
}

export type PlayerKiPair = {
  global: number;
  hero: number;
};

/**
 * Load current display ki per slot (global / hero). Used to compute match deltas.
 */
export async function loadPlayerKiBySlot(
  leagueId: string,
  entries: Pick<RatingPreviewRosterEntry, 'playerId' | 'heroId' | 'slot'>[],
  db: Db = prisma,
): Promise<Map<number, PlayerKiPair>> {
  const sorted = [...entries].sort((a, b) => a.slot - b.slot);
  const result = new Map<number, PlayerKiPair>();

  if (sorted.length === 0) {
    return result;
  }

  await ensurePlayerRatings(leagueId, sorted, db);

  const playerIds = sorted.map((entry) => entry.playerId);
  const withHero = sorted.filter(
    (entry): entry is typeof entry & { heroId: number } => entry.heroId != null,
  );
  const [globals, heroes, gameCounts] = await Promise.all([
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
    db.matchPlayer.groupBy({
      by: ['playerId'],
      where: {
        playerId: { in: playerIds },
        match: { leagueId, status: MatchStatus.COMPLETED },
        result: { in: [MatchResult.WIN, MatchResult.LOSS] },
      },
      _count: { _all: true },
    }),
  ]);

  const globalByPlayer = new Map(globals.map((row) => [row.playerId, row]));
  const gamesByPlayer = new Map(
    gameCounts.map((row) => [row.playerId, row._count._all]),
  );
  const heroKey = (playerId: string, heroId: number) => `${playerId}:${heroId}`;
  const heroByKey = new Map(
    heroes.map((row) => [heroKey(row.playerId, row.heroId), row]),
  );

  for (const entry of sorted) {
    const global = globalByPlayer.get(entry.playerId) ?? defaultMuSigma();
    const globalGames = gamesByPlayer.get(entry.playerId) ?? 0;
    const globalKi = displayOrdinal(global.mu, global.sigma, globalGames);

    if (entry.heroId == null) {
      result.set(entry.slot, { global: globalKi, hero: globalKi });
      continue;
    }

    const heroRow = heroByKey.get(heroKey(entry.playerId, entry.heroId));
    const hero = heroRow ?? defaultMuSigma();
    const heroGames = heroRow?.matchesPlayed ?? 0;
    result.set(entry.slot, {
      global: globalKi,
      hero: displayOrdinal(hero.mu, hero.sigma, heroGames),
    });
  }

  return result;
}

/**
 * Build completed-match preview lines with final ki and after−before deltas.
 */
export function buildCompletedRatingPreview(
  entries: RatingPreviewRosterEntry[],
  beforeBySlot: Map<number, PlayerKiPair>,
  afterBySlot: Map<number, PlayerKiPair>,
): LobbyRatingPreview {
  const players: LobbyRatingPlayerLine[] = [...entries]
    .sort((a, b) => a.slot - b.slot)
    .map((entry) => {
      const after = afterBySlot.get(entry.slot) ?? {
        global: displayOrdinal(DEFAULT_MU, DEFAULT_SIGMA),
        hero: displayOrdinal(DEFAULT_MU, DEFAULT_SIGMA),
      };
      const before = beforeBySlot.get(entry.slot) ?? after;
      return {
        slot: entry.slot,
        nick: entry.nick,
        globalOrdinal: after.global,
        heroOrdinal: after.hero,
        globalDelta: after.global - before.global,
        heroDelta: after.hero - before.hero,
        isQuitter: entry.isQuitter,
      };
    });

  return { players };
}

/**
 * Load display ki + win chance for the current lobby roster.
 * Read-only prediction: never calls rate().
 * On failure, returns default ki and omits winChance.
 */
export async function loadLobbyRatingPreview(
  leagueId: string,
  entries: RatingPreviewRosterEntry[],
): Promise<LobbyRatingPreview> {
  const sorted = [...entries].sort((a, b) => a.slot - b.slot);

  if (sorted.length === 0) {
    return { players: [] };
  }

  try {
    await ensurePlayerRatings(leagueId, sorted);

    if (sorted.some((entry) => entry.heroId != null)) {
      const catalogHeroIds = await listCatalogHeroIds();
      if (catalogHeroIds.length > 0) {
        const withHero = sorted.filter(
          (entry): entry is typeof entry & { heroId: number } => entry.heroId != null,
        );
        await prisma.playerHeroRating.createMany({
          data: withHero.flatMap((entry) =>
            catalogHeroIds.map((heroId) => ({
              leagueId,
              playerId: entry.playerId,
              heroId,
            })),
          ),
          skipDuplicates: true,
        });
      }
    }

    const playerIds = sorted.map((entry) => entry.playerId);
    const [globals, heroes, gameCounts] = await Promise.all([
      prisma.playerRating.findMany({
        where: { leagueId, playerId: { in: playerIds } },
      }),
      prisma.playerHeroRating.findMany({
        where: { leagueId, playerId: { in: playerIds } },
      }),
      prisma.matchPlayer.groupBy({
        by: ['playerId'],
        where: {
          playerId: { in: playerIds },
          match: { leagueId, status: MatchStatus.COMPLETED },
          result: { in: [MatchResult.WIN, MatchResult.LOSS] },
        },
        _count: { _all: true },
      }),
    ]);

    const globalByPlayer = new Map(globals.map((row) => [row.playerId, row]));
    const gamesByPlayer = new Map(
      gameCounts.map((row) => [row.playerId, row._count._all]),
    );
    const heroKey = (playerId: string, heroId: number) => `${playerId}:${heroId}`;
    const heroByKey = new Map(
      heroes.map((row) => [heroKey(row.playerId, row.heroId), row]),
    );

    const players: LobbyRatingPlayerLine[] = sorted.map((entry) => {
      const global = globalByPlayer.get(entry.playerId) ?? defaultMuSigma();
      const globalGames = gamesByPlayer.get(entry.playerId) ?? 0;
      const globalOrdinal = displayOrdinal(global.mu, global.sigma, globalGames);

      if (entry.heroId == null) {
        return {
          slot: entry.slot,
          nick: entry.nick,
          globalOrdinal,
          heroOrdinal: globalOrdinal,
          isQuitter: entry.isQuitter,
        };
      }

      const heroRow = heroByKey.get(heroKey(entry.playerId, entry.heroId));
      const hero = heroRow ?? defaultMuSigma();
      const heroGames = heroRow?.matchesPlayed ?? 0;
      return {
        slot: entry.slot,
        nick: entry.nick,
        globalOrdinal,
        heroOrdinal: displayOrdinal(hero.mu, hero.sigma, heroGames),
        isQuitter: entry.isQuitter,
      };
    });

    const { teamA, teamB } = splitRosterByTeam(sorted);
    if (teamA.length === 0 || teamB.length === 0) {
      return { players };
    }

    const teamEntities = (team: RatingPreviewRosterEntry[]) =>
      toOpenSkillRatings(
        team.flatMap((entry) => {
          const global = globalByPlayer.get(entry.playerId) ?? defaultMuSigma();
          const hero =
            entry.heroId == null
              ? defaultMuSigma()
              : heroByKey.get(heroKey(entry.playerId, entry.heroId)) ?? defaultMuSigma();
          return ratingEntitiesForPlayer(global, hero, entry.heroId);
        }),
      );

    const [pA, pB] = predictWin([teamEntities(teamA), teamEntities(teamB)]);
    const winChance = roundWinPercents(pA ?? 0.5, pB ?? 0.5);
    const lookup: BalanceRatingLookup = {
      global: (playerId) => {
        const row = globalByPlayer.get(playerId);
        return row ? { mu: row.mu, sigma: row.sigma } : defaultMuSigma();
      },
      hero: (playerId, heroId) => {
        const row = heroByKey.get(heroKey(playerId, heroId));
        return row ? { mu: row.mu, sigma: row.sigma } : defaultMuSigma();
      },
    };

    const balanceRoster = sorted.flatMap((entry) =>
      entry.heroId == null
        ? []
        : [
            {
              playerId: entry.playerId,
              slot: entry.slot,
              team: entry.team,
              heroId: entry.heroId,
              nick: entry.nick,
            },
          ],
    );

    let balanceSuggestion: BalanceSuggestion | undefined;
    if (
      balanceRoster.length === sorted.length &&
      isUnbalancedWinChance(winChance.teamAPercent)
    ) {
      try {
        balanceSuggestion = suggestBalanceMove(balanceRoster, lookup, winChance);
      } catch (error) {
        log.warn({ err: error }, 'Failed to compute balance suggestion');
      }
    }

    return {
      players,
      winChance,
      balanceSuggestion,
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
    team: number;
    heroId: number | null;
    isQuitter?: boolean;
    player: { username: string };
  }[],
): RatingPreviewRosterEntry[] {
  return matchPlayers.map((entry) => ({
    playerId: entry.playerId,
    slot: entry.slot,
    team: entry.team as 1 | 2,
    heroId: entry.heroId,
    nick: entry.player.username,
    isQuitter: entry.isQuitter,
  }));
}
