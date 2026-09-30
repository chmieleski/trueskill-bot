import { MatchResult, MatchStatus } from '@dbz/db';
import type { ApiHeroStatsQuery } from '../../api/parse-query.js';
import { prisma } from '../../lib/prisma.js';
import {
  resolveHeroSelection,
  resolveHeroSelectionByObjectId,
  statsRowMatchesHeroSelection,
  type HeroSelection,
} from '../game/game-hero-catalog.js';
import { resolveItemNames } from '../game/game-item-catalog.js';
import { winRatePercent } from '../rating/rank-reset-display.js';
import { filterRowsToLastNMatches, formatKda } from './hero-stats.js';

export type ApiCombatRow = {
  matchId: string;
  playerId: string;
  username: string;
  result: 'WIN' | 'LOSS';
  completedAt: Date | null;
  kills: number;
  deaths: number;
  trainDeaths: number;
  damagePhys: number;
  damageMagic: number;
  damageTotal: number;
  takenPhys: number;
  takenMagic: number;
  takenTotal: number;
  heal: number;
  heroObjectId: number | null;
  heroName: string | null;
  itemObjectIds: number[];
};

export type ApiHeroWindowAggregate = {
  games: number;
  wins: number;
  losses: number;
  winRatePercent: number | null;
  avgDamageTotal: number;
  avgDamagePhys: number;
  avgDamageMagic: number;
  avgTakenTotal: number;
  avgTakenPhys: number;
  avgTakenMagic: number;
  avgHeal: number;
  avgKills: number;
  avgDeaths: number;
  avgTrainDeaths: number;
  sumDamageTotal: number;
  sumDamagePhys: number;
  sumDamageMagic: number;
  sumTakenTotal: number;
  sumTakenPhys: number;
  sumTakenMagic: number;
  sumHeal: number;
  sumKills: number;
  sumDeaths: number;
  sumTrainDeaths: number;
  kda: string;
  topPlayers: ApiTopPlayer[];
};

export type ApiTopPlayer = {
  username: string;
  games: number;
  wins: number;
  losses: number;
  winRatePercent: number;
  avgDamageTotal: number;
  avgDamagePhys: number;
  avgDamageMagic: number;
  avgTakenTotal: number;
  avgHeal: number;
  kda: string;
};

export type ApiHeroRecentGame = {
  matchId: string;
  playerId: string;
  username: string;
  result: 'WIN' | 'LOSS';
  completedAt: string | null;
  kills: number;
  deaths: number;
  trainDeaths: number;
  damagePhys: number;
  damageMagic: number;
  damageTotal: number;
  takenPhys: number;
  takenMagic: number;
  takenTotal: number;
  heal: number;
  heroObjectId: number | null;
  heroName: string | null;
  items: Array<{ objectId: number; name: string | null }>;
};

export type ApiHeroStatsResponse = {
  leagueId: string;
  hero: { objectId: number | null; name: string };
  windows: Partial<Record<'all' | 'last' | 'range', ApiHeroWindowAggregate>>;
  recentGames: ApiHeroRecentGame[];
};

export type ApiMatchStatsPlayer = {
  playerId: string;
  username: string;
  team: number;
  slot: number;
  result: 'WIN' | 'LOSS' | 'DRAW' | null;
  kills: number;
  deaths: number;
  trainDeaths: number;
  damagePhys: number;
  damageMagic: number;
  damageTotal: number;
  takenPhys: number;
  takenMagic: number;
  takenTotal: number;
  heal: number;
  heroObjectId: number | null;
  heroName: string | null;
  items: Array<{ objectId: number; name: string | null }>;
};

export type ApiMatchStatsResponse = {
  matchId: string;
  leagueId: string;
  status: string;
  externalId: string | null;
  completedAt: string | null;
  players: ApiMatchStatsPlayer[];
};

/** Prisma-shaped row used by `mapPrismaCombatRows` (unit-testable without DB). */
export type PrismaCombatRowSource = {
  playerId: string;
  result: MatchResult | null;
  matchId: string;
  player: { username: string };
  match: { completedAt: Date | null };
  stats: {
    heroName: string | null;
    heroObjectId: number | null;
    kills: number;
    deaths: number;
    trainDeaths: number;
    damagePhys: number;
    damageMagic: number;
    damageTotal: number;
    takenPhys: number;
    takenMagic: number;
    takenTotal: number;
    heal: number;
    itemSlot1: number;
    itemSlot2: number;
    itemSlot3: number;
    itemSlot4: number;
    itemSlot5: number;
    itemSlot6: number;
  } | null;
};

const TOP_PLAYERS_MIN_GAMES = 3;

const COMBAT_STATS_SELECT = {
  heroName: true,
  heroObjectId: true,
  kills: true,
  deaths: true,
  trainDeaths: true,
  damagePhys: true,
  damageMagic: true,
  damageTotal: true,
  takenPhys: true,
  takenMagic: true,
  takenTotal: true,
  heal: true,
  itemSlot1: true,
  itemSlot2: true,
  itemSlot3: true,
  itemSlot4: true,
  itemSlot5: true,
  itemSlot6: true,
} as const;

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Non-zero item slot object ids in slot order. */
export function itemObjectIdsFromSlots(stats: {
  itemSlot1: number;
  itemSlot2: number;
  itemSlot3: number;
  itemSlot4: number;
  itemSlot5: number;
  itemSlot6: number;
}): number[] {
  return [
    stats.itemSlot1,
    stats.itemSlot2,
    stats.itemSlot3,
    stats.itemSlot4,
    stats.itemSlot5,
    stats.itemSlot6,
  ].filter((objectId) => objectId !== 0);
}

/** Filter rows with completedAt in [from, to). Null completedAt excluded from range. */
export function filterRowsToCompletedAtRange(
  rows: ApiCombatRow[],
  from: Date,
  to: Date,
): ApiCombatRow[] {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  return rows.filter((row) => {
    if (row.completedAt === null) {
      return false;
    }
    const ms = row.completedAt.getTime();
    return ms >= fromMs && ms < toMs;
  });
}

type PlayerBucket = {
  username: string;
  wins: number;
  losses: number;
  damageTotal: number;
  damagePhys: number;
  damageMagic: number;
  takenTotal: number;
  heal: number;
  kills: number;
  deaths: number;
};

function bucketCombatPlayers(rows: ApiCombatRow[]): Map<string, PlayerBucket> {
  const buckets = new Map<string, PlayerBucket>();
  for (const row of rows) {
    let bucket = buckets.get(row.playerId);
    if (!bucket) {
      bucket = {
        username: row.username,
        wins: 0,
        losses: 0,
        damageTotal: 0,
        damagePhys: 0,
        damageMagic: 0,
        takenTotal: 0,
        heal: 0,
        kills: 0,
        deaths: 0,
      };
      buckets.set(row.playerId, bucket);
    }
    if (row.result === 'WIN') {
      bucket.wins += 1;
    } else {
      bucket.losses += 1;
    }
    bucket.damageTotal += row.damageTotal;
    bucket.damagePhys += row.damagePhys;
    bucket.damageMagic += row.damageMagic;
    bucket.takenTotal += row.takenTotal;
    bucket.heal += row.heal;
    bucket.kills += row.kills;
    bucket.deaths += row.deaths;
  }
  return buckets;
}

function rankApiTopPlayers(rows: ApiCombatRow[], limit: number): ApiTopPlayer[] {
  const players = [...bucketCombatPlayers(rows).entries()]
    .map(([, bucket]) => {
      const games = bucket.wins + bucket.losses;
      return {
        username: bucket.username,
        games,
        wins: bucket.wins,
        losses: bucket.losses,
        winRatePercent: winRatePercent(bucket.wins, bucket.losses) ?? 0,
        avgDamageTotal: Math.round(bucket.damageTotal / games),
        avgDamagePhys: Math.round(bucket.damagePhys / games),
        avgDamageMagic: Math.round(bucket.damageMagic / games),
        avgTakenTotal: Math.round(bucket.takenTotal / games),
        avgHeal: Math.round(bucket.heal / games),
        kda: formatKda(bucket.kills, bucket.deaths),
      };
    })
    .filter((entry) => entry.games >= TOP_PLAYERS_MIN_GAMES);

  players.sort(
    (left, right) =>
      right.winRatePercent - left.winRatePercent ||
      right.games - left.games ||
      left.username.localeCompare(right.username),
  );

  return players.slice(0, limit);
}

/** Aggregate one window; topPlayersLimit 0 → empty topPlayers. Min 3 games for top list. */
export function aggregateApiHeroWindow(
  rows: ApiCombatRow[],
  topPlayersLimit: number,
): ApiHeroWindowAggregate {
  const games = rows.length;
  const wins = rows.filter((row) => row.result === 'WIN').length;
  const losses = rows.filter((row) => row.result === 'LOSS').length;

  const sumKills = rows.reduce((sum, row) => sum + row.kills, 0);
  const sumDeaths = rows.reduce((sum, row) => sum + row.deaths, 0);
  const sumTrainDeaths = rows.reduce((sum, row) => sum + row.trainDeaths, 0);
  const sumDamageTotal = rows.reduce((sum, row) => sum + row.damageTotal, 0);
  const sumDamagePhys = rows.reduce((sum, row) => sum + row.damagePhys, 0);
  const sumDamageMagic = rows.reduce((sum, row) => sum + row.damageMagic, 0);
  const sumTakenTotal = rows.reduce((sum, row) => sum + row.takenTotal, 0);
  const sumTakenPhys = rows.reduce((sum, row) => sum + row.takenPhys, 0);
  const sumTakenMagic = rows.reduce((sum, row) => sum + row.takenMagic, 0);
  const sumHeal = rows.reduce((sum, row) => sum + row.heal, 0);

  const topPlayers = topPlayersLimit === 0 ? [] : rankApiTopPlayers(rows, topPlayersLimit);

  return {
    games,
    wins,
    losses,
    winRatePercent: winRatePercent(wins, losses),
    avgDamageTotal: Math.round(mean(rows.map((row) => row.damageTotal))),
    avgDamagePhys: Math.round(mean(rows.map((row) => row.damagePhys))),
    avgDamageMagic: Math.round(mean(rows.map((row) => row.damageMagic))),
    avgTakenTotal: Math.round(mean(rows.map((row) => row.takenTotal))),
    avgTakenPhys: Math.round(mean(rows.map((row) => row.takenPhys))),
    avgTakenMagic: Math.round(mean(rows.map((row) => row.takenMagic))),
    avgHeal: Math.round(mean(rows.map((row) => row.heal))),
    avgKills: Math.round(mean(rows.map((row) => row.kills))),
    avgDeaths: Math.round(mean(rows.map((row) => row.deaths))),
    avgTrainDeaths: Math.round(mean(rows.map((row) => row.trainDeaths))),
    sumDamageTotal,
    sumDamagePhys,
    sumDamageMagic,
    sumTakenTotal,
    sumTakenPhys,
    sumTakenMagic,
    sumHeal,
    sumKills,
    sumDeaths,
    sumTrainDeaths,
    kda: formatKda(sumKills, sumDeaths),
    topPlayers,
  };
}

/** Map item slots to API items using a name map (missing → name: null). */
export function mapItemSlots(
  objectIds: number[],
  names: Map<number, string>,
): Array<{ objectId: number; name: string | null }> {
  return objectIds.map((objectId) => ({
    objectId,
    name: names.get(objectId) ?? null,
  }));
}

/**
 * Map Prisma match-player rows to combat rows for the resolved hero.
 * Skips non-WIN/LOSS results, missing stats, and rows that do not match selection.
 */
export function mapPrismaCombatRows(
  rows: PrismaCombatRowSource[],
  selection: HeroSelection,
): ApiCombatRow[] {
  const mapped: ApiCombatRow[] = [];

  for (const row of rows) {
    if (row.result !== MatchResult.WIN && row.result !== MatchResult.LOSS) {
      continue;
    }
    const stats = row.stats;
    if (!stats || !statsRowMatchesHeroSelection(stats, selection)) {
      continue;
    }

    mapped.push({
      matchId: row.matchId,
      playerId: row.playerId,
      username: row.player.username,
      result: row.result,
      completedAt: row.match.completedAt,
      kills: stats.kills,
      deaths: stats.deaths,
      trainDeaths: stats.trainDeaths,
      damagePhys: stats.damagePhys,
      damageMagic: stats.damageMagic,
      damageTotal: stats.damageTotal,
      takenPhys: stats.takenPhys,
      takenMagic: stats.takenMagic,
      takenTotal: stats.takenTotal,
      heal: stats.heal,
      heroObjectId: stats.heroObjectId,
      heroName: stats.heroName,
      itemObjectIds: itemObjectIdsFromSlots(stats),
    });
  }

  return mapped;
}

function toApiRecentGame(row: ApiCombatRow, names: Map<number, string>): ApiHeroRecentGame {
  return {
    matchId: row.matchId,
    playerId: row.playerId,
    username: row.username,
    result: row.result,
    completedAt: row.completedAt?.toISOString() ?? null,
    kills: row.kills,
    deaths: row.deaths,
    trainDeaths: row.trainDeaths,
    damagePhys: row.damagePhys,
    damageMagic: row.damageMagic,
    damageTotal: row.damageTotal,
    takenPhys: row.takenPhys,
    takenMagic: row.takenMagic,
    takenTotal: row.takenTotal,
    heal: row.heal,
    heroObjectId: row.heroObjectId,
    heroName: row.heroName,
    items: mapItemSlots(row.itemObjectIds, names),
  };
}

/** Newest player-game rows up to `limit`, ISO-serialized for the API. */
export function pickRecentApiCombatGames(
  rows: ApiCombatRow[],
  limit: number,
  names: Map<number, string>,
): ApiHeroRecentGame[] {
  return [...rows]
    .sort(
      (left, right) =>
        (right.completedAt?.getTime() ?? 0) - (left.completedAt?.getTime() ?? 0) ||
        right.matchId.localeCompare(left.matchId),
    )
    .slice(0, limit)
    .map((row) => toApiRecentGame(row, names));
}

/** Resolve hero selection from an already-decoded path key (digits → objectId). */
async function resolveHeroSelectionFromKey(
  gameId: string,
  leagueId: string,
  heroKey: string,
): Promise<HeroSelection | null> {
  if (/^\d+$/.test(heroKey)) {
    return resolveHeroSelectionByObjectId(gameId, leagueId, Number(heroKey));
  }
  return resolveHeroSelection(gameId, leagueId, heroKey);
}

function windowRowsForScope(
  allRows: ApiCombatRow[],
  query: ApiHeroStatsQuery,
): {
  windows: Partial<Record<'all' | 'last' | 'range', ApiHeroWindowAggregate>>;
  recentPool: ApiCombatRow[];
} {
  const windows: Partial<Record<'all' | 'last' | 'range', ApiHeroWindowAggregate>> = {};
  const { scope, games, topPlayers } = query;

  let lastRows: ApiCombatRow[] | undefined;
  if (scope === 'last' || scope === 'both') {
    lastRows = filterRowsToLastNMatches(allRows, games);
    windows.last = aggregateApiHeroWindow(lastRows, topPlayers);
  }

  if (scope === 'all' || scope === 'both') {
    windows.all = aggregateApiHeroWindow(allRows, topPlayers);
  }

  if (scope === 'range') {
    const from = query.from;
    if (from === null) {
      throw new Error('from is required when scope is range');
    }
    const to = query.to ?? new Date();
    const rangeRows = filterRowsToCompletedAtRange(allRows, from, to);
    windows.range = aggregateApiHeroWindow(rangeRows, topPlayers);
    return { windows, recentPool: rangeRows };
  }

  if (scope === 'all') {
    return { windows, recentPool: allRows };
  }

  // `last` or `both` → recentGames from the last-N pool
  return { windows, recentPool: lastRows ?? [] };
}

/**
 * Load league-wide combat aggregates for one hero (name or objectId path key).
 * `heroKey` must already be URI-decoded by the HTTP route.
 */
export async function loadApiHeroCombatStats(input: {
  leagueId: string;
  gameId: string;
  heroKey: string;
  query: ApiHeroStatsQuery;
}): Promise<ApiHeroStatsResponse | null> {
  const selection = await resolveHeroSelectionFromKey(input.gameId, input.leagueId, input.heroKey);
  if (!selection) {
    return null;
  }

  const rows = await prisma.matchPlayer.findMany({
    where: {
      result: { in: [MatchResult.WIN, MatchResult.LOSS] },
      match: { leagueId: input.leagueId, status: MatchStatus.COMPLETED },
      stats: { heroName: { not: null } },
    },
    select: {
      playerId: true,
      result: true,
      matchId: true,
      player: { select: { username: true } },
      match: { select: { completedAt: true } },
      stats: { select: COMBAT_STATS_SELECT },
    },
  });

  const allRows = mapPrismaCombatRows(rows, selection);
  if (allRows.length === 0) {
    return null;
  }

  const itemIds = allRows.flatMap((row) => row.itemObjectIds);
  const names = await resolveItemNames(input.gameId, itemIds);
  const { windows, recentPool } = windowRowsForScope(allRows, input.query);

  return {
    leagueId: input.leagueId,
    hero: { objectId: selection.objectId, name: selection.displayName },
    windows,
    recentGames: pickRecentApiCombatGames(recentPool, input.query.recentLimit, names),
  };
}

/** Load per-player combat stats for one match in a league (any status with stats). */
export async function loadApiMatchCombatStats(input: {
  leagueId: string;
  gameId: string;
  matchId: string;
}): Promise<ApiMatchStatsResponse | null> {
  const match = await prisma.match.findFirst({
    where: { id: input.matchId, leagueId: input.leagueId },
    select: {
      id: true,
      leagueId: true,
      status: true,
      completedAt: true,
      statsReport: { select: { externalId: true } },
      players: {
        orderBy: { slot: 'asc' },
        select: {
          playerId: true,
          team: true,
          slot: true,
          result: true,
          player: { select: { username: true } },
          stats: { select: COMBAT_STATS_SELECT },
        },
      },
    },
  });

  if (!match || match.leagueId === null) {
    return null;
  }

  const withStats = match.players.filter((player) => player.stats !== null);
  const itemIds = withStats.flatMap((player) => itemObjectIdsFromSlots(player.stats!));
  const names = await resolveItemNames(input.gameId, itemIds);

  return {
    matchId: match.id,
    leagueId: match.leagueId,
    status: match.status,
    externalId: match.statsReport?.externalId ?? null,
    completedAt: match.completedAt?.toISOString() ?? null,
    players: withStats.map((player) => {
      const stats = player.stats!;
      return {
        playerId: player.playerId,
        username: player.player.username,
        team: player.team,
        slot: player.slot,
        result: player.result,
        kills: stats.kills,
        deaths: stats.deaths,
        trainDeaths: stats.trainDeaths,
        damagePhys: stats.damagePhys,
        damageMagic: stats.damageMagic,
        damageTotal: stats.damageTotal,
        takenPhys: stats.takenPhys,
        takenMagic: stats.takenMagic,
        takenTotal: stats.takenTotal,
        heal: stats.heal,
        heroObjectId: stats.heroObjectId,
        heroName: stats.heroName,
        items: mapItemSlots(itemObjectIdsFromSlots(stats), names),
      };
    }),
  };
}
