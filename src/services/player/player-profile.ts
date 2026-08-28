import { prisma } from '../../lib/prisma.js';
import { normalizeNick } from './player-nick.js';
import {
  applyPendingDecayForPlayers,
  DECAY_SETTINGS_SELECT,
  resolveRankDecayFooter,
  toDecayLeagueContext,
} from '../rating/rating-decay.js';
import { displayOrdinal, isCalibrating } from '../rating/rating-math.js';
import {
  gamesByPlayerFromStats,
  heroStatsFor,
  loadMatchDisplayStats,
  loadPendingGrieferKiTaxByPlayer,
  sideStatsFor,
  winRatePercent,
} from '../rating/rank-reset-display.js';
import { getGameProfileForLeague } from '../league/league-profile.js';
import { loadRankHeroesFromMatchStats } from './player-match-stats-heroes.js';

const DEFAULT_MU = 25;
const DEFAULT_SIGMA = 8.333;

/** Max hero rows on `/rank` (most-played first). */
export const RANK_HERO_TOP = 10;

export class PlayerServiceError extends Error {
  readonly ephemeral: boolean;

  constructor(message: string, options?: { ephemeral?: boolean }) {
    super(message);
    this.name = 'PlayerServiceError';
    this.ephemeral = options?.ephemeral === true;
  }
}

export type PlayerProfileHero = {
  heroId: number;
  name: string;
  ki: number;
  matchesPlayed: number;
  wins: number;
  losses: number;
  winRatePercent: number | null;
  /** When set (WOS stats heroes), shown instead of public ki in the hero table. */
  leadingColumn?: string;
};

export type PlayerProfile = {
  playerId: string;
  username: string;
  discordId: string | null;
  globalKi: number;
  rankPosition: number | null;
  wins: number;
  losses: number;
  /** Completed or cancelled matches where this player was marked a quitter. */
  quits: number;
  /** Completed or cancelled matches where this player was marked a griefer (not quitter). */
  griefs: number;
  /** Summed deferred ki tax pending until season rollover. */
  pendingGrieferKiTax: number;
  winRatePercent: number | null;
  heroes: PlayerProfileHero[];
  /**
   * Per-side W–L when League.showSideWinLoss is on; null when the line is hidden.
   * team1 / team2 map to GameProfile.teamNames.
   */
  sideWinLoss: {
    team1: { wins: number; losses: number };
    team2: { wins: number; losses: number };
  } | null;
  /** Idle/crunch decay hint for linked players; null when not shown. */
  decayFooter: string | null;
};

export type RankLookup =
  | { kind: 'self'; discordId: string }
  | { kind: 'user'; discordId: string }
  | { kind: 'nick'; nick: string }
  | { kind: 'both' };

/** Competition rank: 1 + count of strictly higher scores (ties share place). */
export function competitionRank(targetKi: number, allKis: number[]): number {
  let higher = 0;
  for (const ki of allKis) {
    if (ki > targetKi) {
      higher += 1;
    }
  }
  return higher + 1;
}

export function coldStartKi(): number {
  return displayOrdinal(DEFAULT_MU, DEFAULT_SIGMA);
}

/** Rank profile heroes: most games first, then ki, then name; capped at {@link RANK_HERO_TOP}. */
export function sortRankProfileHeroes(heroes: PlayerProfileHero[]): PlayerProfileHero[] {
  return [...heroes]
    .sort(
      (a, b) => b.matchesPlayed - a.matchesPlayed || b.ki - a.ki || a.name.localeCompare(b.name),
    )
    .slice(0, RANK_HERO_TOP);
}

export function parseRankOptions(input: {
  selfDiscordId: string;
  userDiscordId?: string | null;
  nick?: string | null;
}): RankLookup {
  const nick = input.nick ? normalizeNick(input.nick) || null : null;
  const userDiscordId = input.userDiscordId?.trim() || null;

  if (userDiscordId && nick) {
    return { kind: 'both' };
  }
  if (userDiscordId) {
    return { kind: 'user', discordId: userDiscordId };
  }
  if (nick) {
    return { kind: 'nick', nick };
  }
  return { kind: 'self', discordId: input.selfDiscordId };
}

async function findPlayerByDiscordId(gameId: string, discordId: string) {
  return prisma.player.findUnique({
    where: { gameId_discordId: { gameId, discordId } },
  });
}

async function findPlayerByNick(gameId: string, nick: string) {
  const exact = await prisma.player.findUnique({
    where: { gameId_username: { gameId, username: normalizeNick(nick) } },
  });
  if (exact) {
    return exact;
  }

  const matches = await prisma.player.findMany({
    where: {
      gameId,
      username: { equals: normalizeNick(nick), mode: 'insensitive' },
    },
    take: 2,
  });

  return matches.length === 1 ? matches[0]! : null;
}

/** Resolve a Player row for rank/history lookups (not `both`). */
export async function findPlayerForRankLookup(
  gameId: string,
  lookup: Exclude<RankLookup, { kind: 'both' }>,
) {
  if (lookup.kind === 'nick') {
    return findPlayerByNick(gameId, lookup.nick);
  }
  return findPlayerByDiscordId(gameId, lookup.discordId);
}

export async function loadPlayerProfile(
  leagueId: string,
  lookup: RankLookup,
): Promise<PlayerProfile> {
  if (lookup.kind === 'both') {
    throw new PlayerServiceError('Provide either a Discord user or a nick, not both.');
  }

  const gameProfile = await getGameProfileForLeague(leagueId);
  const gameId = gameProfile.gameId;

  const player = await findPlayerForRankLookup(gameId, lookup);

  if (!player) {
    if (lookup.kind === 'self') {
      throw new PlayerServiceError(
        'Your Discord is not linked to an in-game nick for this league’s game. Use /link to bind it.',
        { ephemeral: true },
      );
    }
    throw new PlayerServiceError('Player not found.');
  }

  const includeHeroRatings = gameProfile.heroBinding === 'slot_bound';
  const includeStatsHeroes = gameProfile.postMatchStats !== 'none';

  // Catch up idle decay for the looked-up player before μ → ki / rank.
  await applyPendingDecayForPlayers(leagueId, [player.id]);

  const [league, rating, allRatings, heroRatings, statsHeroes, displayStats, pendingTaxByPlayer] =
    await Promise.all([
      prisma.league.findUnique({
        where: { id: leagueId },
        select: {
          status: true,
          decayEnabled: true,
          seasonEndsAt: true,
          crunchStartedAt: true,
          archivedAt: true,
          showSideWinLoss: true,
          ...DECAY_SETTINGS_SELECT,
        },
      }),
      prisma.playerRating.findUnique({
        where: { leagueId_playerId: { leagueId, playerId: player.id } },
      }),
      prisma.playerRating.findMany({
        where: { leagueId },
        select: { playerId: true, mu: true, sigma: true },
      }),
      includeHeroRatings
        ? prisma.playerHeroRating.findMany({
            where: { leagueId, playerId: player.id, matchesPlayed: { gt: 0 } },
            include: { hero: true },
          })
        : Promise.resolve([]),
      includeStatsHeroes ? loadRankHeroesFromMatchStats(leagueId, player.id) : Promise.resolve([]),
      // W/L/games/quits and soft-ki z restart after the player's latest rank reset.
      loadMatchDisplayStats(leagueId),
      loadPendingGrieferKiTaxByPlayer(leagueId, [player.id]),
    ]);

  const displayStatsByPlayer = displayStats.byPlayer;
  const gamesByPlayer = gamesByPlayerFromStats(displayStatsByPlayer);
  const mine = displayStatsByPlayer.get(player.id) ?? {
    games: 0,
    wins: 0,
    losses: 0,
    quits: 0,
    griefs: 0,
  };
  const { games, wins, losses, quits, griefs } = mine;
  const pendingGrieferKiTax = pendingTaxByPlayer.get(player.id) ?? 0;

  const globalKi = rating ? displayOrdinal(rating.mu, rating.sigma, games) : coldStartKi();

  const calibratedKis = allRatings
    .filter((row) => !isCalibrating(gamesByPlayer.get(row.playerId) ?? 0))
    .map((row) => displayOrdinal(row.mu, row.sigma, gamesByPlayer.get(row.playerId) ?? 0));
  if (!rating && !isCalibrating(games)) {
    calibratedKis.push(globalKi);
  }

  const rankPosition = isCalibrating(games) ? null : competitionRank(globalKi, calibratedKis);
  const decayFooter =
    league && rating
      ? resolveRankDecayFooter({
          decayEnabled: league.decayEnabled,
          leagueGames: games,
          isNewPlayer: rating.isNewPlayer,
          lastQualifyingActivityAt: rating.lastQualifyingActivityAt,
          league: toDecayLeagueContext(league),
        })
      : null;
  const winRatePercentValue = winRatePercent(wins, losses);
  const heroes = includeStatsHeroes
    ? statsHeroes
    : sortRankProfileHeroes(
        heroRatings.map((row) => {
          const heroWl = heroStatsFor(displayStats.byHero, player.id, row.heroId);
          return {
            heroId: row.heroId,
            name: row.hero.name,
            ki: displayOrdinal(row.mu, row.sigma, row.matchesPlayed),
            matchesPlayed: row.matchesPlayed,
            wins: heroWl.wins,
            losses: heroWl.losses,
            winRatePercent: winRatePercent(heroWl.wins, heroWl.losses),
          };
        }),
      );

  return {
    playerId: player.id,
    username: player.username,
    discordId: player.discordId,
    globalKi,
    rankPosition,
    wins,
    losses,
    quits,
    griefs,
    pendingGrieferKiTax,
    winRatePercent: winRatePercentValue,
    heroes,
    sideWinLoss: league?.showSideWinLoss ? sideStatsFor(displayStats.bySide, player.id) : null,
    decayFooter,
  };
}
