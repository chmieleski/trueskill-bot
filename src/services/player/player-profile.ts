import { MatchStatus, MatchResult } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { normalizeNick } from './player-nick.js';
import { displayOrdinal } from '../rating/rating-math.js';

const DEFAULT_MU = 25;
const DEFAULT_SIGMA = 8.333;

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
};

export type PlayerProfile = {
  playerId: string;
  username: string;
  discordId: string | null;
  globalKi: number;
  rankPosition: number;
  wins: number;
  losses: number;
  /** Completed or cancelled matches where this player was marked a quitter. */
  quits: number;
  winRatePercent: number | null;
  heroes: PlayerProfileHero[];
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

async function findPlayerByDiscordId(discordId: string) {
  return prisma.player.findUnique({ where: { discordId } });
}

async function findPlayerByNick(nick: string) {
  const exact = await prisma.player.findUnique({
    where: { username: normalizeNick(nick) },
  });
  if (exact) {
    return exact;
  }

  const matches = await prisma.player.findMany({
    where: { username: { equals: normalizeNick(nick), mode: 'insensitive' } },
    take: 2,
  });

  if (matches.length === 1) {
    return matches[0]!;
  }

  return null;
}

export async function loadPlayerProfile(
  leagueId: string,
  lookup: RankLookup,
): Promise<PlayerProfile> {
  if (lookup.kind === 'both') {
    throw new PlayerServiceError(
      'Provide either a Discord user or a nick, not both.',
    );
  }

  let player =
    lookup.kind === 'nick'
      ? await findPlayerByNick(lookup.nick)
      : await findPlayerByDiscordId(lookup.discordId);

  if (!player) {
    if (lookup.kind === 'self') {
      throw new PlayerServiceError(
        'Your Discord is not linked to an in-game nick. Use /link to bind it.',
        { ephemeral: true },
      );
    }
    throw new PlayerServiceError('Player not found.');
  }

  const [rating, allRatings, matchPlayers, quits, heroRatings, gameCounts] =
    await Promise.all([
      prisma.playerRating.findUnique({
        where: { leagueId_playerId: { leagueId, playerId: player.id } },
      }),
      prisma.playerRating.findMany({
        where: { leagueId },
        select: { playerId: true, mu: true, sigma: true },
      }),
      prisma.matchPlayer.findMany({
        where: {
          playerId: player.id,
          match: { leagueId, status: MatchStatus.COMPLETED },
          result: { in: [MatchResult.WIN, MatchResult.LOSS] },
        },
        select: { result: true },
      }),
      // Include CANCELLED: cancel-with-quitters still applies penalties and keeps flags.
      // Exclude IN_PROGRESS so provisional quit marks do not inflate the count.
      prisma.matchPlayer.count({
        where: {
          playerId: player.id,
          isQuitter: true,
          match: {
            leagueId,
            status: { in: [MatchStatus.COMPLETED, MatchStatus.CANCELLED] },
          },
        },
      }),
      prisma.playerHeroRating.findMany({
        where: { leagueId, playerId: player.id, matchesPlayed: { gt: 0 } },
        include: { hero: true },
      }),
      prisma.matchPlayer.groupBy({
        by: ['playerId'],
        where: {
          match: { leagueId, status: MatchStatus.COMPLETED },
          result: { in: [MatchResult.WIN, MatchResult.LOSS] },
        },
        _count: { _all: true },
      }),
    ]);

  const gamesByPlayer = new Map(
    gameCounts.map((row) => [row.playerId, row._count._all]),
  );

  let wins = 0;
  let losses = 0;
  for (const row of matchPlayers) {
    if (row.result === MatchResult.WIN) {
      wins += 1;
    } else if (row.result === MatchResult.LOSS) {
      losses += 1;
    }
  }

  const games = wins + losses;
  const globalKi = rating
    ? displayOrdinal(rating.mu, rating.sigma, games)
    : coldStartKi();

  const allKis = allRatings.map((row) =>
    displayOrdinal(row.mu, row.sigma, gamesByPlayer.get(row.playerId) ?? 0),
  );
  if (!rating) {
    allKis.push(globalKi);
  }

  const rankPosition = competitionRank(globalKi, allKis);
  const winRatePercent =
    games > 0 ? Math.round((wins / games) * 1000) / 10 : null;

  const heroes: PlayerProfileHero[] = heroRatings
    .map((row) => ({
      heroId: row.heroId,
      name: row.hero.name,
      ki: displayOrdinal(row.mu, row.sigma, row.matchesPlayed),
      matchesPlayed: row.matchesPlayed,
    }))
    .sort((a, b) => b.ki - a.ki || a.name.localeCompare(b.name));

  return {
    playerId: player.id,
    username: player.username,
    discordId: player.discordId,
    globalKi,
    rankPosition,
    wins,
    losses,
    quits,
    winRatePercent,
    heroes,
  };
}
