import { winRatePercent } from '../rating/rank-reset-display.js';
import { formatKda } from './hero-stats.js';

export type ApiCombatRow = {
  matchId: string;
  playerId: string;
  username: string;
  result: 'WIN' | 'LOSS';
  completedAt: Date | null;
  kills: number;
  deaths: number;
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
  sumDamageTotal: number;
  sumDamagePhys: number;
  sumDamageMagic: number;
  sumTakenTotal: number;
  sumTakenPhys: number;
  sumTakenMagic: number;
  sumHeal: number;
  sumKills: number;
  sumDeaths: number;
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

const TOP_PLAYERS_MIN_GAMES = 3;

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
    sumDamageTotal,
    sumDamagePhys,
    sumDamageMagic,
    sumTakenTotal,
    sumTakenPhys,
    sumTakenMagic,
    sumHeal,
    sumKills,
    sumDeaths,
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
