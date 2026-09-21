/**
 * One-off analysis: lobby-relative ki deltas vs OpenSkill baseline.
 * Usage: npx tsx scripts/analyze-lobby-rating-deltas.ts [--prod]
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@dbz/db';
import { env } from '../src/config/env.js';
import { displayOrdinal } from '../src/services/rating/rating-math.js';
import { simulatePostMatchRatings } from '../src/services/rating/rating-update.js';
import {
  gamesByPlayerFromStats,
  loadMatchDisplayStatsByPlayer,
} from '../src/services/rating/rank-reset-display.js';

const useProd = process.argv.includes('--prod');
const connectionString = useProd ? process.env.PROD_DIRECT_URL : env.databaseUrl;

if (!connectionString) {
  console.error('Missing database URL');
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

type Row = {
  matchId: string;
  username: string;
  ki: number;
  offset: number;
  won: boolean;
  simDelta: number;
  persistedDelta: number | null;
  lobbyAvg: number;
};

async function main(): Promise<void> {
  const dbInfo = await prisma.$queryRaw<{ db: string }[]>`
    SELECT current_database() AS db
  `;
  console.log(`Analyzing ${useProd ? 'PROD' : 'LOCAL'} DB:`, dbInfo[0]?.db);

  const counts = await prisma.$queryRaw<
    { completed: number; snapshots: number; ratings: number }[]
  >`
    SELECT
      (SELECT COUNT(*)::int FROM "Match" WHERE status = 'COMPLETED') AS completed,
      (SELECT COUNT(*)::int FROM "MatchRatingSnapshot") AS snapshots,
      (SELECT COUNT(*)::int FROM "PlayerRating") AS ratings
  `;
  console.log('Counts:', counts[0]);

  const mpCols = await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'MatchPlayer' ORDER BY ordinal_position
  `;
  const hasPersisted = mpCols.some((c) => c.column_name === 'globalKiDelta');

  const matches = await prisma.$queryRaw<
    { id: string; leagueId: string; completedAt: Date | null }[]
  >`
    SELECT m.id, m."leagueId", m."completedAt"
    FROM "Match" m
    WHERE m.status = 'COMPLETED'
    ORDER BY m."completedAt" DESC
  `;

  const allRows: Row[] = [];

  for (const m of matches) {
    const players = hasPersisted
      ? await prisma.$queryRaw<
          {
            playerId: string;
            slot: number;
            team: number;
            heroId: number | null;
            isQuitter: boolean;
            result: string;
            username: string;
            globalKiDelta: number | null;
          }[]
        >`
          SELECT mp."playerId", mp.slot, mp.team, mp."heroId", mp."isQuitter",
                 mp.result::text AS result, p.username, mp."globalKiDelta"
          FROM "MatchPlayer" mp
          JOIN "Player" p ON p.id = mp."playerId"
          WHERE mp."matchId" = ${m.id}
        `
      : await prisma.$queryRaw<
          {
            playerId: string;
            slot: number;
            team: number;
            heroId: number | null;
            isQuitter: boolean;
            result: string;
            username: string;
          }[]
        >`
          SELECT mp."playerId", mp.slot, mp.team, mp."heroId", mp."isQuitter",
                 mp.result::text AS result, p.username
          FROM "MatchPlayer" mp
          JOIN "Player" p ON p.id = mp."playerId"
          WHERE mp."matchId" = ${m.id}
        `;

    const active = players.filter(
      (p) => !p.isQuitter && (p.result === 'WIN' || p.result === 'LOSS'),
    );
    if (active.length < 2) {
      continue;
    }

    const winningTeam = active.find((p) => p.result === 'WIN')?.team;
    if (!winningTeam) {
      continue;
    }

    const playerIds = [...new Set(active.map((p) => p.playerId))];
    const [globals, stats] = await Promise.all([
      prisma.playerRating.findMany({
        where: { leagueId: m.leagueId, playerId: { in: playerIds } },
      }),
      loadMatchDisplayStatsByPlayer(m.leagueId, playerIds, prisma),
    ]);
    const gamesByPlayer = gamesByPlayerFromStats(stats);
    const globalMap = new Map(globals.map((r) => [r.playerId, r]));

    const withHero = active.filter((p) => p.heroId != null);
    const heroes =
      withHero.length > 0
        ? await prisma.playerHeroRating.findMany({
            where: {
              leagueId: m.leagueId,
              OR: withHero.map((p) => ({
                playerId: p.playerId,
                heroId: p.heroId!,
              })),
            },
          })
        : [];
    const heroMap = new Map(
      heroes.map((r) => [`${r.playerId}:${r.heroId}`, { mu: r.mu, sigma: r.sigma }]),
    );

    const preRows = active.map((p) => {
      const g = globalMap.get(p.playerId) ?? { mu: 25, sigma: 8.333 };
      const games = gamesByPlayer.get(p.playerId) ?? 0;
      const ki = displayOrdinal(g.mu, g.sigma, games);
      return {
        ...p,
        mu: g.mu,
        sigma: g.sigma,
        games,
        ki,
        won: p.result === 'WIN',
      };
    });

    const lobbyAvg = preRows.reduce((s, r) => s + r.ki, 0) / preRows.length;
    const startGlobal = new Map(preRows.map((r) => [r.playerId, { mu: r.mu, sigma: r.sigma }]));
    const roster = players.map((p) => ({
      playerId: p.playerId,
      slot: p.slot,
      team: p.team as 1 | 2,
      heroId: p.heroId,
      isQuitter: p.isQuitter,
    }));

    const after = simulatePostMatchRatings(roster, winningTeam as 1 | 2, startGlobal, heroMap);

    for (const r of preRows) {
      const ag = after.globalByPlayer.get(r.playerId);
      if (!ag) {
        continue;
      }
      const simDelta = displayOrdinal(ag.mu, ag.sigma, r.games + 1) - r.ki;
      const persisted =
        'globalKiDelta' in r && r.globalKiDelta != null ? Number(r.globalKiDelta) : null;
      allRows.push({
        matchId: m.id.slice(0, 8),
        username: r.username,
        ki: r.ki,
        offset: r.ki - lobbyAvg,
        won: r.won,
        simDelta,
        persistedDelta: persisted,
        lobbyAvg: Math.round(lobbyAvg),
      });
    }
  }

  const avg = (arr: Row[], key: keyof Row): string =>
    arr.length ? (arr.reduce((s, x) => s + Number(x[key] ?? 0), 0) / arr.length).toFixed(1) : 'n/a';

  console.log('\n=== AGGREGATE (simulated global ki Δ) ===');
  console.log('Player-match rows:', allRows.length);
  const winners = allRows.filter((r) => r.won);
  const losers = allRows.filter((r) => !r.won);
  console.log(
    'Above avg (+200) WIN  avg Δ',
    avg(
      winners.filter((r) => r.offset > 200),
      'simDelta',
    ),
    `(n=${winners.filter((r) => r.offset > 200).length})`,
  );
  console.log(
    'Below avg (-200) WIN  avg Δ',
    avg(
      winners.filter((r) => r.offset < -200),
      'simDelta',
    ),
    `(n=${winners.filter((r) => r.offset < -200).length})`,
  );
  console.log(
    'Above avg (+200) LOSS avg Δ',
    avg(
      losers.filter((r) => r.offset > 200),
      'simDelta',
    ),
    `(n=${losers.filter((r) => r.offset > 200).length})`,
  );
  console.log(
    'Below avg (-200) LOSS avg Δ',
    avg(
      losers.filter((r) => r.offset < -200),
      'simDelta',
    ),
    `(n=${losers.filter((r) => r.offset < -200).length})`,
  );

  console.log('\n=== HIGH vs LOW LOSERS (same match, spread > 800 ki) ===');
  const byMatch = new Map<string, Row[]>();
  for (const r of allRows) {
    const list = byMatch.get(r.matchId) ?? [];
    list.push(r);
    byMatch.set(r.matchId, list);
  }

  let caseN = 0;
  for (const [mid, rows] of byMatch) {
    const lossers = rows.filter((r) => !r.won).sort((a, b) => b.ki - a.ki);
    if (lossers.length < 2) {
      continue;
    }
    const high = lossers[0]!;
    const low = lossers[lossers.length - 1]!;
    if (high.ki - low.ki < 800) {
      continue;
    }
    caseN += 1;
    console.log(`Match ${mid} lobbyAvg ${high.lobbyAvg}`);
    console.log(
      `  HIGH ${high.username} ki ${high.ki} simΔ ${high.simDelta} persistedΔ ${high.persistedDelta}`,
    );
    console.log(
      `  LOW  ${low.username} ki ${low.ki} simΔ ${low.simDelta} persistedΔ ${low.persistedDelta}`,
    );
    console.log(
      `  ratio |low|/|high| ${(Math.abs(low.simDelta) / Math.max(1, Math.abs(high.simDelta))).toFixed(2)}`,
    );
  }
  console.log('Cases found:', caseN);

  const withPersisted = allRows.filter((r) => r.persistedDelta != null);
  if (withPersisted.length > 0) {
    const diffs = withPersisted.map((r) => Math.abs(r.persistedDelta! - r.simDelta));
    console.log(
      `\nPersisted vs simulated: rows ${withPersisted.length}, max diff ${Math.max(...diffs)}`,
    );
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
