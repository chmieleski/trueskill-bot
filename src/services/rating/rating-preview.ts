import type { Prisma } from '@prisma/client';
import { predictWin } from 'openskill';
import { assertTeam } from '../../domain/game-profile.js';
import { listCatalogHeroIds } from '../guild/hero-catalog.js';
import { getGameProfileForLeague } from '../league/league-profile.js';
import { resolveLeagueConfig } from '../league/league-wc3stats.js';
import { prisma } from '../../lib/prisma.js';
import { createLogger } from '../../lib/logger.js';
import {
  ratingEntitiesForBalance,
  rosterEntriesWithHeroId,
  type BalancePredictWinOptions,
  type MuSigma,
} from './rating-entities.js';
import {
  displayOrdinal,
  roundWinPercents,
  splitRosterByTeam,
  toOpenSkillRatings,
} from './rating-math.js';
import {
  gamesByPlayerFromStats,
  habitualQuitterFromStats,
  loadMatchDisplayStatsByPlayer,
  type PlayerMatchDisplayStats,
} from './rank-reset-display.js';
import {
  suggestBalanceMoves,
  type BalanceRatingLookup,
  type BalanceSuggestion,
} from '../lobby/lobby-balance.js';
import { applyPendingDecayForPlayers } from './rating-decay.js';

export type { BalanceSuggestion };

const log = createLogger('rating-preview');

const DEFAULT_MU = 25;
const DEFAULT_SIGMA = 8.333;

export type WinChancePercents = {
  teamAPercent: number;
  teamBPercent: number;
};

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
  isGriefer?: boolean;
  /** Live PENDING/in-progress: from PlayerRating.isNewPlayer. */
  isNewPlayer?: boolean;
  /** Completed/history: from MatchPlayer.wasNewPlayer snapshot. */
  wasNewPlayer?: boolean;
  showHero?: boolean;
  /** League completed WIN/LOSS count used for the Calibrating gate. */
  leagueGames: number;
  /** League `/rank` quit rate is 50%+ (post–rank-reset). */
  habitualQuitter?: boolean;
}

export interface LobbyRatingPreview {
  players: LobbyRatingPlayerLine[];
  /** Present only when both teams have ≥1 human. Pre-match OpenSkill predictWin. */
  winChance?: WinChancePercents;
  /** Up to 3 improving single moves (best first); empty-slot moves deduped per player. */
  balanceSuggestions?: BalanceSuggestion[];
}

export type RatingPreviewRosterEntry = {
  playerId: string;
  slot: number;
  team: 1 | 2;
  heroId: number | null;
  nick: string;
  isQuitter?: boolean;
  isGriefer?: boolean;
  wasNewPlayer?: boolean;
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

/**
 * Cold-start missing ratings, then catch up idle decay before any μ read.
 * Callers must re-read PlayerRating rows after this returns.
 */
async function ensurePlayerRatingsWithDecayCatchUp(
  leagueId: string,
  entries: Pick<RatingPreviewRosterEntry, 'playerId' | 'heroId'>[],
  db: Db = prisma,
): Promise<void> {
  await ensurePlayerRatings(leagueId, entries, db);
  if (entries.length === 0) {
    return;
  }
  await applyPendingDecayForPlayers(
    leagueId,
    entries.map((entry) => entry.playerId),
    db,
  );
}

function defaultMuSigma(): MuSigma {
  return { mu: DEFAULT_MU, sigma: DEFAULT_SIGMA };
}

/**
 * Pre-match win chance from μ/σ maps (same predictWin path as the lobby).
 * Hero slots use an 80% player / 20% hero blend; `rate()` is independent overall then hero.
 * Returns undefined when either team has no humans.
 */
export function computeWinChanceFromRatings(
  entries: Pick<RatingPreviewRosterEntry, 'playerId' | 'slot' | 'team' | 'heroId'>[],
  globalByPlayer: Map<string, MuSigma>,
  heroByKey: Map<string, MuSigma>,
  options?: BalancePredictWinOptions,
): WinChancePercents | undefined {
  const { teamA, teamB } = splitRosterByTeam([...entries].sort((a, b) => a.slot - b.slot));
  if (teamA.length === 0 || teamB.length === 0) {
    return undefined;
  }

  const heroKey = (playerId: string, heroId: number) => `${playerId}:${heroId}`;
  const teamEntities = (team: typeof teamA) =>
    toOpenSkillRatings(
      team.flatMap((entry) => {
        const global = globalByPlayer.get(entry.playerId) ?? defaultMuSigma();
        const hero =
          entry.heroId == null
            ? defaultMuSigma()
            : (heroByKey.get(heroKey(entry.playerId, entry.heroId)) ?? defaultMuSigma());
        return ratingEntitiesForBalance(global, hero, entry.heroId, options);
      }),
    );

  const [pA, pB] = predictWin([teamEntities(teamA), teamEntities(teamB)]);
  return roundWinPercents(pA ?? 0.5, pB ?? 0.5);
}

/**
 * Load league μ/σ for a roster and compute pre-match win chance.
 * Call before OpenSkill writes so the percents match the lobby.
 */
export async function loadRosterWinChance(
  leagueId: string,
  entries: Pick<RatingPreviewRosterEntry, 'playerId' | 'slot' | 'team' | 'heroId'>[],
  db: Db = prisma,
): Promise<WinChancePercents | undefined> {
  if (entries.length === 0) {
    return undefined;
  }

  await ensurePlayerRatingsWithDecayCatchUp(leagueId, entries, db);

  const leagueConfig = await resolveLeagueConfig(leagueId);
  const balanceOptions: BalancePredictWinOptions = {
    staticSigma: leagueConfig.balanceStaticSigmaEnabled,
  };

  const playerIds = entries.map((entry) => entry.playerId);
  const withHero = entries.filter(
    (entry): entry is typeof entry & { heroId: number } => entry.heroId != null,
  );
  const [globals, heroes] = await Promise.all([
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

  const globalByPlayer = new Map(
    globals.map((row) => [row.playerId, { mu: row.mu, sigma: row.sigma }]),
  );
  const heroByKey = new Map(
    heroes.map((row) => [`${row.playerId}:${row.heroId}`, { mu: row.mu, sigma: row.sigma }]),
  );

  return computeWinChanceFromRatings(entries, globalByPlayer, heroByKey, balanceOptions);
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

  await ensurePlayerRatingsWithDecayCatchUp(leagueId, sorted, db);

  const playerIds = sorted.map((entry) => entry.playerId);
  const withHero = sorted.filter(
    (entry): entry is typeof entry & { heroId: number } => entry.heroId != null,
  );
  const [globals, heroes, displayStatsByPlayer] = await Promise.all([
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
    loadMatchDisplayStatsByPlayer(leagueId, playerIds, db),
  ]);

  const globalByPlayer = new Map(globals.map((row) => [row.playerId, row]));
  const gamesByPlayer = gamesByPlayerFromStats(displayStatsByPlayer);
  const heroKey = (playerId: string, heroId: number) => `${playerId}:${heroId}`;
  const heroByKey = new Map(heroes.map((row) => [heroKey(row.playerId, row.heroId), row]));

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
 * Optional `winChance` is the pre-match lobby predictWin (not post-update).
 */
export function buildCompletedRatingPreview(
  entries: RatingPreviewRosterEntry[],
  beforeBySlot: Map<number, PlayerKiPair>,
  afterBySlot: Map<number, PlayerKiPair>,
  leagueGamesByPlayer: Map<string, number>,
  displayStatsByPlayer: Map<string, PlayerMatchDisplayStats>,
  winChance?: WinChancePercents,
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
        isGriefer: entry.isGriefer,
        ...(entry.wasNewPlayer === true ? { wasNewPlayer: true as const } : {}),
        showHero: entry.heroId != null,
        leagueGames: leagueGamesByPlayer.get(entry.playerId) ?? 0,
        habitualQuitter: habitualQuitterFromStats(displayStatsByPlayer, entry.playerId),
      };
    });

  return winChance ? { players, winChance } : { players };
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
    await ensurePlayerRatingsWithDecayCatchUp(leagueId, sorted);

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
    const [globals, heroes, displayStatsByPlayer, leagueConfig] = await Promise.all([
      prisma.playerRating.findMany({
        where: { leagueId, playerId: { in: playerIds } },
      }),
      prisma.playerHeroRating.findMany({
        where: { leagueId, playerId: { in: playerIds } },
      }),
      loadMatchDisplayStatsByPlayer(leagueId, playerIds),
      resolveLeagueConfig(leagueId),
    ]);
    const balanceOptions: BalancePredictWinOptions = {
      staticSigma: leagueConfig.balanceStaticSigmaEnabled,
    };

    const globalByPlayer = new Map(globals.map((row) => [row.playerId, row]));
    const gamesByPlayer = gamesByPlayerFromStats(displayStatsByPlayer);
    const heroKey = (playerId: string, heroId: number) => `${playerId}:${heroId}`;
    const heroByKey = new Map(heroes.map((row) => [heroKey(row.playerId, row.heroId), row]));

    const players: LobbyRatingPlayerLine[] = sorted.map((entry) => {
      const globalRow = globalByPlayer.get(entry.playerId);
      const global = globalRow ?? defaultMuSigma();
      const globalGames = gamesByPlayer.get(entry.playerId) ?? 0;
      const globalOrdinal = displayOrdinal(global.mu, global.sigma, globalGames);
      const newFlag = globalRow?.isNewPlayer === true ? { isNewPlayer: true as const } : {};

      if (entry.heroId == null) {
        return {
          slot: entry.slot,
          nick: entry.nick,
          globalOrdinal,
          heroOrdinal: globalOrdinal,
          isQuitter: entry.isQuitter,
          isGriefer: entry.isGriefer,
          ...newFlag,
          showHero: false,
          leagueGames: globalGames,
          habitualQuitter: habitualQuitterFromStats(displayStatsByPlayer, entry.playerId),
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
        isGriefer: entry.isGriefer,
        ...newFlag,
        showHero: true,
        leagueGames: globalGames,
        habitualQuitter: habitualQuitterFromStats(displayStatsByPlayer, entry.playerId),
      };
    });

    const { teamA, teamB } = splitRosterByTeam(sorted);
    if (teamA.length === 0 || teamB.length === 0) {
      return { players };
    }

    const globalMuSigma = new Map(
      [...globalByPlayer.entries()].map(([playerId, row]) => [
        playerId,
        { mu: row.mu, sigma: row.sigma },
      ]),
    );
    const heroMuSigma = new Map(
      [...heroByKey.entries()].map(([key, row]) => [key, { mu: row.mu, sigma: row.sigma }]),
    );
    const winChance = computeWinChanceFromRatings(
      sorted,
      globalMuSigma,
      heroMuSigma,
      balanceOptions,
    );
    if (!winChance) {
      return { players };
    }

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

    const profile = await getGameProfileForLeague(leagueId);
    const balanceRoster = sorted.map((entry) => ({
      playerId: entry.playerId,
      slot: entry.slot,
      team: entry.team,
      heroId: entry.heroId,
      nick: entry.nick,
    }));

    let balanceSuggestions: BalanceSuggestion[] | undefined;
    try {
      const suggestions = suggestBalanceMoves(
        balanceRoster,
        lookup,
        winChance,
        balanceOptions,
        profile,
      );
      if (suggestions.length > 0) {
        balanceSuggestions = suggestions;
      }
    } catch (error) {
      log.warn({ err: error }, 'Failed to compute balance suggestions');
    }

    return {
      players,
      winChance,
      balanceSuggestions,
    };
  } catch (error) {
    log.error({ err: error }, 'Failed to load lobby rating preview');
    return {
      players: sorted.map((entry) => ({
        slot: entry.slot,
        nick: entry.nick,
        globalOrdinal: displayOrdinal(DEFAULT_MU, DEFAULT_SIGMA),
        heroOrdinal: displayOrdinal(DEFAULT_MU, DEFAULT_SIGMA),
        showHero: entry.heroId != null,
        leagueGames: 0,
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
    isGriefer?: boolean;
    wasNewPlayer?: boolean;
    player: { username: string };
  }[],
): RatingPreviewRosterEntry[] {
  return matchPlayers.map((entry) => ({
    playerId: entry.playerId,
    slot: entry.slot,
    team: assertTeam(entry.team),
    heroId: entry.heroId,
    nick: entry.player.username,
    isQuitter: entry.isQuitter,
    isGriefer: entry.isGriefer,
    wasNewPlayer: entry.wasNewPlayer,
  }));
}
