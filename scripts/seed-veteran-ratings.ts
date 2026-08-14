/**
 * One-shot seed: create veteran players (if missing) and set global OpenSkill
 * μ/σ so public ki matches the starting boost tiers.
 *
 * Only touches Player + PlayerRating (global). Hero ratings stay cold-start.
 *
 * Run: npx tsx scripts/seed-veteran-ratings.ts
 * Dry: npx tsx scripts/seed-veteran-ratings.ts --dry-run
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { displayOrdinal } from '../src/services/rating-math.js';

/** Group 1 — strong veterans → 4200 ki (μ 31, σ 5). */
const GROUP_1 = {
  targetKi: 4200,
  mu: 31,
  sigma: 5,
  usernames: [
    'Tinys',
    'Wuru',
    'dragonnpx4',
    'Keltras',
    'alian12',
    'Cosmos',
    'notverrigod',
    'LotharACR',
    'hi1',
    'jafar2700',
    'Ghorderis',
    'B0jan',
    'reron'
  ],
} as const;

/** Group 2 — known good players → 3000 ki (μ 28, σ 6). */
const GROUP_2 = {
  targetKi: 3000,
  mu: 28,
  sigma: 6,
  usernames: [
    'krabmoneygun',
    'chronologic',
    'zaveghunter',
    'biobenji',
    'ПуховикКруг', // mouse (WC3 Cyrillic nick)
    'sapphirez',
    'kamex',
    'biggamer',
  ],
} as const;

const DRY_RUN = process.argv.includes('--dry-run');

function assertKi(mu: number, sigma: number, expected: number, label: string): void {
  const actual = displayOrdinal(mu, sigma);
  if (actual !== expected) {
    throw new Error(`${label}: expected ki ${expected}, got ${actual} (μ=${mu}, σ=${sigma})`);
  }
}

async function upsertVeteran(
  db: PrismaClient,
  username: string,
  mu: number,
  sigma: number,
  targetKi: number,
): Promise<{ username: string; created: boolean; ki: number }> {
  let player = await db.player.findUnique({ where: { username } });
  let created = false;

  if (!player) {
    if (!DRY_RUN) {
      player = await db.player.create({ data: { username } });
    }
    created = true;
  }

  if (!DRY_RUN && player) {
    await db.playerRating.upsert({
      where: { playerId: player.id },
      create: { playerId: player.id, mu, sigma },
      update: { mu, sigma },
    });
  }

  return {
    username,
    created,
    ki: displayOrdinal(mu, sigma),
  };
}

async function main(): Promise<void> {
  assertKi(GROUP_1.mu, GROUP_1.sigma, GROUP_1.targetKi, 'Group 1');
  assertKi(GROUP_2.mu, GROUP_2.sigma, GROUP_2.targetKi, 'Group 2');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Missing DATABASE_URL');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

  console.log(DRY_RUN ? 'Dry run — no writes.\n' : 'Seeding veteran global ratings…\n');

  try {
    const tiers = [
      { label: 'Group 1 (4200 ki)', ...GROUP_1 },
      { label: 'Group 2 (3000 ki)', ...GROUP_2 },
    ];

    for (const tier of tiers) {
      console.log(`── ${tier.label}  μ=${tier.mu} σ=${tier.sigma}`);
      for (const username of tier.usernames) {
        const result = await upsertVeteran(
          prisma,
          username,
          tier.mu,
          tier.sigma,
          tier.targetKi,
        );
        const flag = result.created ? 'NEW' : 'upd';
        console.log(`  [${flag}] ${result.username} → ${result.ki} ki`);
      }
      console.log('');
    }

    console.log(DRY_RUN ? 'Dry run complete.' : 'Done.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
