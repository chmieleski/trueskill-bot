# Rating Decay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add league-scoped idle ki decay (real μ erosion on `PlayerRating`), end-of-season crunch week, and top-3 prize lock so inactive players cannot sit the board.

**Architecture:** Pure decay math in `rating-decay.ts` applied by a daily UTC batch scheduler plus catch-up on μ reads. League flags (`decayEnabled`, `seasonEndsAt`, `crunchStartedAt`) drive mid-season vs crunch tiers and prize eligibility. Leaderboard medals skip ineligible players during crunch; `/rank` always shows true ki.

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest, OpenSkill display helpers from `rating-math.ts`

**Spec:** `docs/superpowers/specs/2026-08-23-rating-decay-design.md`

## Global Constraints

- Scope: `general` (keyed by `leagueId`; no WC3-only imports in decay core)
- English-only user-facing strings
- Decay changes **`PlayerRating.mu` only**; σ and hero ratings untouched
- Public score is **ki**; never raw μ on embeds
- Calibrating (`leagueGames < 5`) and **`isNewPlayer`** do not decay
- Qualifying activity = completed **non-quit** match only
- Continue rollover successors get **`decayEnabled = false`**
- No new production env / SSM keys
- ESM imports use `.js` extension; named exports
- Conventional Commits on this branch

## File map

| File                                            | Role                                           |
| ----------------------------------------------- | ---------------------------------------------- |
| `prisma/schema.prisma`                          | League + PlayerRating decay/crunch columns     |
| `prisma/migrations/<ts>_rating_decay/`          | SQL + activity backfill                        |
| `src/services/rating/rating-decay.ts`           | Pure math, crunch/prize helpers, apply + batch |
| `src/services/rating/rating-decay.test.ts`      | Unit tests                                     |
| `src/services/rating/rating-decay-scheduler.ts` | Daily UTC tick                                 |
| `src/services/rating/index.ts`                  | Re-exports                                     |
| `src/services/rating/rating-update.ts`          | Streak reset on non-quit complete              |
| `src/services/rating/rank-reset.ts`             | Clear streak counters on wipe                  |
| `src/services/rating/rating-preview.ts`         | Catch-up before μ reads                        |
| `src/services/leaderboard/leaderboard.ts`       | Catch-up + prizeEligible on entries            |
| `src/services/leaderboard/leaderboard-embed.ts` | Medal assignment + crunch footer               |
| `src/services/league/league-rollover.ts`        | continue → decay off; copy fields              |
| `src/services/league/league-wc3stats.ts`        | `setDecayEnabled` + config view fields         |
| `src/commands/league/league.ts`                 | season_end + crunch subcommands                |
| `src/commands/config/config.ts`                 | `/config set decay` + view                     |
| `src/commands/player/rank.ts`                   | Idle / crunch footers                          |
| `src/events/ready.ts`                           | Start decay scheduler                          |
| Docs + `.cursor/rules/openskill-rating.mdc`     | Staff/player guides + agent rules              |

---

### Task 1: Schema — decay / crunch columns + backfill

**Files:**

- Modify: `prisma/schema.prisma` (`League`, `PlayerRating`)
- Create: `prisma/migrations/20260823230000_rating_decay/migration.sql`

**Interfaces:**

- Produces:
  - `League.decayEnabled Boolean @default(true)`
  - `League.seasonEndsAt DateTime?`
  - `League.crunchStartedAt DateTime?`
  - `PlayerRating.lastQualifyingActivityAt DateTime?`
  - `PlayerRating.idleDecayKiApplied Int @default(0)`
  - `PlayerRating.lastDecayAppliedAt DateTime?`

- [ ] **Step 1: Add fields to schema**

On `League`, after `archivedAt`:

```prisma
  decayEnabled    Boolean   @default(true)
  seasonEndsAt    DateTime?
  crunchStartedAt DateTime?
```

On `PlayerRating`, after `isNewPlayer`:

```prisma
  lastQualifyingActivityAt DateTime?
  idleDecayKiApplied       Int       @default(0)
  lastDecayAppliedAt       DateTime?
```

- [ ] **Step 2: Add migration SQL**

```sql
-- AlterTable League
ALTER TABLE "League" ADD COLUMN "decayEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "League" ADD COLUMN "seasonEndsAt" TIMESTAMP(3);
ALTER TABLE "League" ADD COLUMN "crunchStartedAt" TIMESTAMP(3);

-- AlterTable PlayerRating
ALTER TABLE "PlayerRating" ADD COLUMN "lastQualifyingActivityAt" TIMESTAMP(3);
ALTER TABLE "PlayerRating" ADD COLUMN "idleDecayKiApplied" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PlayerRating" ADD COLUMN "lastDecayAppliedAt" TIMESTAMP(3);

-- Backfill lastQualifyingActivityAt from completed non-quit matches
UPDATE "PlayerRating" AS pr
SET "lastQualifyingActivityAt" = src."maxCompletedAt"
FROM (
  SELECT mp."playerId", m."leagueId", MAX(m."completedAt") AS "maxCompletedAt"
  FROM "MatchPlayer" mp
  JOIN "Match" m ON m.id = mp."matchId"
  WHERE m.status = 'COMPLETED'
    AND mp."isQuitter" = false
    AND m."completedAt" IS NOT NULL
  GROUP BY mp."playerId", m."leagueId"
) AS src
WHERE pr."playerId" = src."playerId"
  AND pr."leagueId" = src."leagueId";
```

- [ ] **Step 3: Generate client**

Run: `npx prisma generate`  
Expected: client includes all six fields

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260823230000_rating_decay
git commit -m "$(cat <<'EOF'
feat(rating): add decay and crunch schema columns

EOF
)"
```

---

### Task 2: Pure decay math + crunch / prize helpers

**Files:**

- Create: `src/services/rating/rating-decay.ts`
- Create: `src/services/rating/rating-decay.test.ts`
- Modify: `src/services/rating/index.ts` (export new symbols)

**Interfaces:**

- Produces:
  - Constants: `MID_GRACE_DAYS = 10`, `MID_TIER1_KI = 50`, `MID_TIER2_KI = 100`, `MID_STREAK_CAP_KI = 1000`, `CRUNCH_GRACE_DAYS = 2`, `CRUNCH_TIER1_KI = 100`, `CRUNCH_TIER2_KI = 200`, `CRUNCH_WINDOW_DAYS = 7`, `PRIZE_LOCK_DAYS = 7`
  - `utcDayIndex(date: Date): number` — floor ms / 86_400_000 from UTC midnight
  - `idleDaysSince(activityAt: Date, now: Date): number`
  - `dailyKiLoss(idleDays: number, inCrunch: boolean): number` — 0 / 50 / 100 / 100 / 200 per spec tables
  - `muFloor(sigma: number, leagueGames: number): number` — `displayConservatismZ(leagueGames) * sigma`
  - `kiLossToMuDelta(kiLoss: number): number` — `-kiLoss / KI_SCALE`
  - `computeDecayDelta(input): { muDelta: number; streakKiApplied: number; kiAppliedThisPass: number }`
  - `isLeagueInCrunch(league, now): boolean`
  - `resolveCrunchStart(league): Date | null`
  - `isPrizeEligible(activityAt, league, now): boolean`
  - Input shape for `computeDecayDelta`:

```typescript
export type ComputeDecayDeltaInput = {
  idleDays: number;
  inCrunch: boolean;
  streakKiApplied: number;
  mu: number;
  sigma: number;
  leagueGames: number;
  /** Whole UTC days to apply (usually 1; 0 for idempotent same-day). */
  utcDaysToApply: number;
};
```

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import {
  computeDecayDelta,
  dailyKiLoss,
  idleDaysSince,
  isLeagueInCrunch,
  isPrizeEligible,
  kiLossToMuDelta,
  muFloor,
} from './rating-decay.js';
import { KI_SCALE } from './rating-math.js';

describe('dailyKiLoss mid-season', () => {
  it('uses grace and tiers', () => {
    expect(dailyKiLoss(10, false)).toBe(0);
    expect(dailyKiLoss(11, false)).toBe(50);
    expect(dailyKiLoss(19, false)).toBe(50);
    expect(dailyKiLoss(20, false)).toBe(100);
  });
});

describe('dailyKiLoss crunch', () => {
  it('uses shorter grace and 2x rates', () => {
    expect(dailyKiLoss(2, true)).toBe(0);
    expect(dailyKiLoss(3, true)).toBe(100);
    expect(dailyKiLoss(9, true)).toBe(100);
    expect(dailyKiLoss(10, true)).toBe(200);
  });
});

describe('kiLossToMuDelta', () => {
  it('maps ki to mu via KI_SCALE', () => {
    expect(kiLossToMuDelta(50)).toBe(-50 / KI_SCALE);
    expect(kiLossToMuDelta(100)).toBe(-100 / KI_SCALE);
  });
});

describe('computeDecayDelta', () => {
  it('caps mid-season streak at 1000 ki', () => {
    const r = computeDecayDelta({
      idleDays: 30,
      inCrunch: false,
      streakKiApplied: 950,
      mu: 40,
      sigma: 1.5,
      leagueGames: 50,
      utcDaysToApply: 1,
    });
    expect(r.kiAppliedThisPass).toBe(50);
    expect(r.streakKiApplied).toBe(1000);
  });

  it('applies no further mid-season decay at cap', () => {
    const r = computeDecayDelta({
      idleDays: 30,
      inCrunch: false,
      streakKiApplied: 1000,
      mu: 40,
      sigma: 1.5,
      leagueGames: 50,
      utcDaysToApply: 1,
    });
    expect(r.muDelta).toBe(0);
    expect(r.kiAppliedThisPass).toBe(0);
  });

  it('does not cap during crunch', () => {
    const r = computeDecayDelta({
      idleDays: 15,
      inCrunch: true,
      streakKiApplied: 1000,
      mu: 40,
      sigma: 1.5,
      leagueGames: 50,
      utcDaysToApply: 1,
    });
    expect(r.kiAppliedThisPass).toBe(200);
  });

  it('respects mu floor near 1000 ki', () => {
    const sigma = 2;
    const games = 50;
    const floor = muFloor(sigma, games);
    const r = computeDecayDelta({
      idleDays: 30,
      inCrunch: false,
      streakKiApplied: 0,
      mu: floor + 0.01,
      sigma,
      leagueGames: games,
      utcDaysToApply: 1,
    });
    expect(r.muDelta).toBeLessThanOrEqual(0);
    expect(floor + 0.01 + r.muDelta).toBeGreaterThanOrEqual(floor - 1e-9);
  });

  it('applies zero when utcDaysToApply is 0', () => {
    const r = computeDecayDelta({
      idleDays: 30,
      inCrunch: false,
      streakKiApplied: 0,
      mu: 40,
      sigma: 1.5,
      leagueGames: 50,
      utcDaysToApply: 0,
    });
    expect(r.muDelta).toBe(0);
  });
});

describe('isLeagueInCrunch', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');

  it('detects auto crunch from seasonEndsAt', () => {
    expect(
      isLeagueInCrunch(
        {
          status: 'ACTIVE',
          decayEnabled: true,
          seasonEndsAt: new Date('2026-08-23T00:00:00.000Z'),
          crunchStartedAt: null,
        },
        now,
      ),
    ).toBe(true);
  });

  it('detects manual crunch', () => {
    expect(
      isLeagueInCrunch(
        {
          status: 'ACTIVE',
          decayEnabled: true,
          seasonEndsAt: null,
          crunchStartedAt: new Date('2026-08-18T00:00:00.000Z'),
        },
        now,
      ),
    ).toBe(true);
  });

  it('is false when decay disabled', () => {
    expect(
      isLeagueInCrunch(
        {
          status: 'ACTIVE',
          decayEnabled: false,
          seasonEndsAt: new Date('2026-08-23T00:00:00.000Z'),
          crunchStartedAt: null,
        },
        now,
      ),
    ).toBe(false);
  });
});

describe('isPrizeEligible', () => {
  it('requires activity within 7 days of seasonEndsAt', () => {
    const league = {
      status: 'ACTIVE' as const,
      decayEnabled: true,
      seasonEndsAt: new Date('2026-08-23T00:00:00.000Z'),
      crunchStartedAt: null,
      archivedAt: null,
    };
    const now = new Date('2026-08-20T12:00:00.000Z');
    expect(isPrizeEligible(new Date('2026-08-17T00:00:00.000Z'), league, now)).toBe(true);
    expect(isPrizeEligible(new Date('2026-08-15T00:00:00.000Z'), league, now)).toBe(false);
  });

  it('uses crunchStart when no seasonEndsAt', () => {
    const league = {
      status: 'ACTIVE' as const,
      decayEnabled: true,
      seasonEndsAt: null,
      crunchStartedAt: new Date('2026-08-18T00:00:00.000Z'),
      archivedAt: null,
    };
    const now = new Date('2026-08-20T12:00:00.000Z');
    expect(isPrizeEligible(new Date('2026-08-18T12:00:00.000Z'), league, now)).toBe(true);
    expect(isPrizeEligible(new Date('2026-08-17T00:00:00.000Z'), league, now)).toBe(false);
  });
});

describe('idleDaysSince', () => {
  it('counts whole UTC days', () => {
    const a = new Date('2026-08-01T23:00:00.000Z');
    const b = new Date('2026-08-11T01:00:00.000Z');
    expect(idleDaysSince(a, b)).toBe(10);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/rating/rating-decay.test.ts`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `rating-decay.ts`**

Implement constants and pure functions per Interfaces. Key rules:

```typescript
export function dailyKiLoss(idleDays: number, inCrunch: boolean): number {
  if (inCrunch) {
    if (idleDays <= 2) return 0;
    if (idleDays <= 9) return 100;
    return 200;
  }
  if (idleDays <= 10) return 0;
  if (idleDays <= 19) return 50;
  return 100;
}
```

For `computeDecayDelta`, for each day in `utcDaysToApply` (or once if applying a multi-day catch-up as a loop of days with increasing idleDays):

1. Compute desired daily ki loss from `dailyKiLoss`.
2. Mid-season: clamp by remaining streak room `MID_STREAK_CAP_KI - streakKiApplied`.
3. Convert to μ; clamp so `mu + muDelta >= muFloor`.
4. Accumulate `kiAppliedThisPass` from actual μ applied × `KI_SCALE` (round consistently — use intended ki loss then recompute μ, then if floor clips, reduce ki applied).

`isLeagueInCrunch`:

```typescript
if (league.status !== 'ACTIVE' || !league.decayEnabled) return false;
if (league.crunchStartedAt && now >= league.crunchStartedAt) {
  if (!league.seasonEndsAt || now < league.seasonEndsAt) return true;
  // after seasonEndsAt with only manual: still true until clear/archive — if seasonEndsAt set and now >= seasonEndsAt, mid-season resumes unless archived
}
if (league.seasonEndsAt) {
  const start = new Date(league.seasonEndsAt.getTime() - CRUNCH_WINDOW_DAYS * 86_400_000);
  return now >= start && now < league.seasonEndsAt;
}
return false;
```

Match the locked spec: when `now >= seasonEndsAt`, crunch ends and mid-season rules resume.

`isPrizeEligible`: only meaningful when crunch active; if `seasonEndsAt` set, require `activityAt >= seasonEndsAt - 7d`; else require `activityAt >= resolveCrunchStart(league)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/rating/rating-decay.test.ts`  
Expected: PASS

- [ ] **Step 5: Export from `index.ts` and commit**

```bash
git add src/services/rating/rating-decay.ts src/services/rating/rating-decay.test.ts src/services/rating/index.ts
git commit -m "$(cat <<'EOF'
feat(rating): add pure decay and crunch helpers

EOF
)"
```

---

### Task 3: `applyPendingDecay` + batch apply

**Files:**

- Modify: `src/services/rating/rating-decay.ts`
- Modify: `src/services/rating/rating-decay.test.ts`
- Modify: `src/services/rating/index.ts`

**Interfaces:**

- Consumes: `computeDecayDelta`, `isLeagueInCrunch`, `idleDaysSince`, `utcDayIndex`
- Produces:
  - `applyPendingDecay(leagueId: string, playerId: string, db?: PrismaClientLike, now?: Date): Promise<{ applied: boolean; mu?: number }>`
  - `applyPendingDecayForPlayers(leagueId: string, playerIds: string[], db?, now?): Promise<void>`
  - `runDecayBatchForAllLeagues(now?: Date): Promise<{ leagues: number; playersUpdated: number }>`

Eligibility inside `applyPendingDecay`:

1. Load league (`status`, `decayEnabled`, season/crunch fields) + `PlayerRating` row.
2. Return no-op if archived, `!decayEnabled`, missing row, `isNewPlayer`, or `lastQualifyingActivityAt == null`.
3. Load `leagueGames` via existing display-stats helper (same source as calibrating gate — `loadMatchDisplayStatsByPlayer` / games since rank reset).
4. If `isCalibrating(leagueGames)` → no-op.
5. Compute `utcDaysToApply` = max(0, `utcDayIndex(now) - utcDayIndex(lastDecayAppliedAt ?? activityAt)`). If `lastDecayAppliedAt` is same UTC day as `now`, `utcDaysToApply = 0`.
6. Call `computeDecayDelta`; if `muDelta === 0` and no state change needed beyond bumping `lastDecayAppliedAt`, still set `lastDecayAppliedAt = now` when days were pending but ki was 0 (grace) so we do not re-scan forever — **or** only bump when grace/idle still needs tracking. Spec: at most one application per UTC day. Prefer: always set `lastDecayAppliedAt` to end of applied window when `utcDaysToApply > 0`.
7. Persist `mu`, `idleDecayKiApplied`, `lastDecayAppliedAt`.

Batch: find ACTIVE leagues with `decayEnabled`, for each load ratings with non-null activity, call apply (or batch-optimized loop).

- [ ] **Step 1: Add failing tests for pending-day math (pure) + mock Prisma apply if project already mocks prisma**

Prefer testing a pure helper:

```typescript
export function pendingUtcDaysToApply(
  lastDecayAppliedAt: Date | null,
  lastQualifyingActivityAt: Date,
  now: Date,
): number {
  const from = lastDecayAppliedAt ?? lastQualifyingActivityAt;
  return Math.max(0, utcDayIndex(now) - utcDayIndex(from));
}
```

```typescript
describe('pendingUtcDaysToApply', () => {
  it('is 0 on the same UTC day', () => {
    const d = new Date('2026-08-20T10:00:00.000Z');
    expect(pendingUtcDaysToApply(d, new Date('2026-08-01T00:00:00.000Z'), d)).toBe(0);
  });

  it('counts days since last apply', () => {
    expect(
      pendingUtcDaysToApply(
        new Date('2026-08-18T00:00:00.000Z'),
        new Date('2026-08-01T00:00:00.000Z'),
        new Date('2026-08-20T12:00:00.000Z'),
      ),
    ).toBe(2);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- src/services/rating/rating-decay.test.ts`

- [ ] **Step 3: Implement apply + batch + pending helper**

Use `prisma` singleton; accept optional `db` for tests matching other services.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/rating-decay.ts src/services/rating/rating-decay.test.ts src/services/rating/index.ts
git commit -m "$(cat <<'EOF'
feat(rating): apply pending decay and batch idle erosion

EOF
)"
```

---

### Task 4: Daily scheduler + ready wiring

**Files:**

- Create: `src/services/rating/rating-decay-scheduler.ts`
- Modify: `src/events/ready.ts`
- Modify: `src/services/rating/index.ts`

**Interfaces:**

- Produces: `startRatingDecayScheduler()`, `stopRatingDecayScheduler()`, `runRatingDecayTick(): Promise<…>`
- Pattern: copy [`match-cleanup.ts`](../../src/services/match/match-cleanup.ts) — `setTimeout` soon after start, then `setInterval`
- Interval: check every hour; only run batch when UTC date changed since last successful batch (module-level `lastBatchUtcDay`), **or** run batch once per day at first tick after UTC midnight. Simplest: interval `60 * 60 * 1000`, and inside tick skip if `utcDayIndex(now) === lastBatchUtcDay`.

- [ ] **Step 1: Implement scheduler**

```typescript
import { createLogger } from '../../lib/logger.js';
import { runDecayBatchForAllLeagues, utcDayIndex } from './rating-decay.js';

const log = createLogger('rating_decay');
const INTERVAL_MS = 60 * 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | undefined;
let lastBatchUtcDay: number | undefined;

export async function runRatingDecayTick(now = new Date()): Promise<void> {
  const day = utcDayIndex(now);
  if (lastBatchUtcDay === day) {
    return;
  }
  const result = await runDecayBatchForAllLeagues(now);
  lastBatchUtcDay = day;
  log.info(result, 'Rating decay batch completed');
}

export function startRatingDecayScheduler(): void {
  if (intervalHandle) {
    log.warn('Rating decay scheduler already running');
    return;
  }
  const tick = (): void => {
    void runRatingDecayTick().catch((error: unknown) => {
      log.error({ err: error }, 'Rating decay tick failed');
    });
  };
  setTimeout(tick, 10_000);
  intervalHandle = setInterval(tick, INTERVAL_MS);
  log.info({ intervalMs: INTERVAL_MS }, 'Rating decay scheduler started');
}

export function stopRatingDecayScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
    log.info('Rating decay scheduler stopped');
  }
}
```

- [ ] **Step 2: Wire in `ready.ts`**

After `startMatchCleanupScheduler(client)`:

```typescript
import { startRatingDecayScheduler } from '../services/rating/index.js';
// ...
startRatingDecayScheduler();
```

- [ ] **Step 3: Commit**

```bash
git add src/services/rating/rating-decay-scheduler.ts src/services/rating/index.ts src/events/ready.ts
git commit -m "$(cat <<'EOF'
feat(rating): schedule daily idle decay batch

EOF
)"
```

---

### Task 5: Match apply — reset streak on non-quit

**Files:**

- Modify: `src/services/rating/rating-update.ts` (or match-report path that persists ratings — wherever `PlayerRating` is written after COMPLETED)
- Modify: existing rating-update / match-report tests

**Interfaces:**

- Consumes: none new
- After successful rating apply for each non-quit participant:

```typescript
await db.playerRating.update({
  where: { leagueId_playerId: { leagueId, playerId } },
  data: {
    lastQualifyingActivityAt: completedAt,
    idleDecayKiApplied: 0,
    lastDecayAppliedAt: null,
  },
});
```

Quitters: do **not** update these fields.

Must run even when New freeze skipped team `rate()`.

- [ ] **Step 1: Locate write site**

Find where `applyMatchRatings` upserts `PlayerRating` and add the activity reset for non-quitters (same transaction if possible).

- [ ] **Step 2: Add / extend unit test**

Assert non-quit update includes activity fields; quitter path does not call update with activity reset (mock prisma).

- [ ] **Step 3: Implement + pass tests**

Run: `npm test -- src/services/rating/rating-update.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/services/rating/rating-update.ts src/services/rating/rating-update.test.ts
git commit -m "$(cat <<'EOF'
feat(rating): reset idle decay streak on non-quit finish

EOF
)"
```

---

### Task 6: Rank reset — clear decay counters

**Files:**

- Modify: `src/services/rating/rank-reset.ts` (`applyRankReset` upsert)
- Modify: `src/services/rating/rank-reset.test.ts` if it asserts upsert `data`

**Interfaces:**

- On upsert `update` and `create`:

```typescript
update: {
  mu: 25,
  sigma: 8.333,
  idleDecayKiApplied: 0,
  lastDecayAppliedAt: null,
  // do NOT clear lastQualifyingActivityAt
},
create: {
  leagueId: preview.leagueId,
  playerId: preview.playerId,
  mu: 25,
  sigma: 8.333,
  idleDecayKiApplied: 0,
  lastDecayAppliedAt: null,
},
```

- [ ] **Step 1: Update upsert + test expectation**
- [ ] **Step 2: Run** `npm test -- src/services/rating/rank-reset.test.ts`
- [ ] **Step 3: Commit**

```bash
git add src/services/rating/rank-reset.ts src/services/rating/rank-reset.test.ts
git commit -m "$(cat <<'EOF'
feat(rating): clear decay streak counters on rank reset

EOF
)"
```

---

### Task 7: Catch-up on μ reads

**Files:**

- Modify: `src/services/rating/rating-preview.ts`
- Modify: `src/services/leaderboard/leaderboard.ts`
- Modify: `src/commands/player/rank.ts` (or rank service loader) if it loads μ without preview

**Interfaces:**

- Before reading μ for lobby preview / predictWin / overall leaderboard / rank profile, call `applyPendingDecayForPlayers(leagueId, playerIds)` then re-read ratings (or have apply return updated μ).

For `loadLobbyRatingPreview` / `ensurePlayerRatings` paths: after ensure, apply pending decay for all roster `playerId`s.

For `loadEligibleOverallRows` / `loadOverallLeaderboardTop`: before computing ki, batch-apply for the candidate player set (or all league ratings with activity — keep it simple: apply for all returned rating rows' playerIds).

- [ ] **Step 1: Wire catch-up into preview + leaderboard loaders**
- [ ] **Step 2: Add a focused test if preview is unit-tested with mocks; otherwise smoke via typecheck**
- [ ] **Step 3: Run** `npm run typecheck` and relevant tests
- [ ] **Step 4: Commit**

```bash
git add src/services/rating/rating-preview.ts src/services/leaderboard/leaderboard.ts src/commands/player/rank.ts
git commit -m "$(cat <<'EOF'
feat(rating): catch up idle decay before mu reads

EOF
)"
```

---

### Task 8: Prize lock medals on overall leaderboard

**Files:**

- Modify: `src/services/leaderboard/leaderboard.ts` (`OverallLeaderboardEntry`)
- Modify: `src/services/leaderboard/leaderboard-embed.ts`
- Modify: `src/services/leaderboard/leaderboard-embed.test.ts`
- Modify: `src/services/leaderboard/leaderboard.test.ts` if entry shape changes

**Interfaces:**

- Extend entry:

```typescript
export type OverallLeaderboardEntry = {
  // …existing…
  prizeEligible?: boolean;
  medalRank?: 1 | 2 | 3 | null; // assigned only during crunch prize lock
};
```

- Add pure helper in `leaderboard-embed.ts` or `rating-decay.ts`:

```typescript
export function assignPrizeMedals(
  entries: Array<{ prizeEligible?: boolean }>,
): Array<1 | 2 | 3 | null> {
  let next = 1 as 1 | 2 | 3;
  return entries.map((entry) => {
    if (next > 3) return null;
    if (entry.prizeEligible === false) return null;
    if (entry.prizeEligible !== true) {
      // when prize lock inactive, callers leave prizeEligible undefined — medals from board rank
      return null;
    }
    const medal = next as 1 | 2 | 3;
    next = (next + 1) as 1 | 2 | 3 | 4;
    return next > 3 && medal === 3 ? 3 : medal;
  });
}
```

Cleaner approach locked by spec:

1. When **not** in crunch: `formatRankPrefix(entry.rank)` unchanged (medals on #1–#3).
2. When **in crunch**: set `prizeEligible` per player; compute `medalRank` for first three eligible; change `formatOverallTable` to:

```typescript
function formatOverallPrefix(entry: OverallLeaderboardEntry, prizeLockActive: boolean): string {
  if (!prizeLockActive) {
    return formatRankPrefix(entry.rank);
  }
  if (entry.medalRank === 1) return '🥇';
  if (entry.medalRank === 2) return '🥈';
  if (entry.medalRank === 3) return '🥉';
  return entry.rank == null ? '—' : `#${entry.rank}`;
}
```

Embed footnote when prize lock active:

`Medals require a completed game in the last 7 days of the season.`

Live embed banner when crunch active:

`Season crunch — play this week to keep your medal spot.`

- [ ] **Step 1: Write failing embed tests for ineligible #1**

```typescript
it('gives gold to first eligible when #1 is locked out', () => {
  const entries = [
    { ...fakeEntry(1), prizeEligible: false, medalRank: null },
    { ...fakeEntry(2), prizeEligible: true, medalRank: 1 },
    { ...fakeEntry(3), prizeEligible: true, medalRank: 2 },
  ];
  const table = formatOverallTable(entries, 'ki', { prizeLockActive: true });
  expect(table).toContain('#1');
  expect(table).toContain('🥇');
  expect(table.indexOf('#1')).toBeLessThan(table.indexOf('🥇'));
});
```

Adapt `formatOverallTable` signature as needed (optional options arg).

- [ ] **Step 2: Implement loader prize flags + embed + pass tests**
- [ ] **Step 3: Commit**

```bash
git add src/services/leaderboard/leaderboard.ts src/services/leaderboard/leaderboard-embed.ts src/services/leaderboard/leaderboard-embed.test.ts
git commit -m "$(cat <<'EOF'
feat(leaderboard): prize-lock medals during season crunch

EOF
)"
```

---

### Task 9: Rollover — continue disables decay; seed decay fields

**Files:**

- Modify: `src/services/league/league-rollover.ts`
- Modify: `src/services/league/league-rollover.test.ts`

**Interfaces:**

- `successorLeagueCreateData`: copy `seasonEndsAt`, `crunchStartedAt`; set:

```typescript
decayEnabled: resetMode === 'continue' ? false : (source.decayEnabled ?? true),
```

Note: `successorLeagueCreateData` today does not receive `resetMode` — either pass it in or set `decayEnabled` after create in the continue/hard/soft branches.

- Extend `seedContinueGlobalRatings` rows to include:

```typescript
{
  (playerId,
    mu,
    sigma,
    lastQualifyingActivityAt,
    idleDecayKiApplied,
    lastDecayAppliedAt,
    isNewPlayer);
}
```

- Soft: copy the same decay fields from source globals.
- Hard: create globals with `idleDecayKiApplied: 0`, null activity/decay timestamps.

- [ ] **Step 1: Failing test — continue successor has `decayEnabled: false`**
- [ ] **Step 2: Implement + pass existing rollover suite**
- [ ] **Step 3: Commit**

```bash
git add src/services/league/league-rollover.ts src/services/league/league-rollover.test.ts
git commit -m "$(cat <<'EOF'
feat(league): disable decay by default on continue rollover

EOF
)"
```

---

### Task 10: Staff commands — season end + crunch

**Files:**

- Modify: `src/commands/league/league.ts`
- Optionally add helpers in `src/services/league/league-wc3stats.ts` or new `league-decay.ts`:
  - `setLeagueSeasonEndsAt(leagueId, date | null)`
  - `startLeagueCrunch(leagueId)`
  - `clearLeagueCrunch(leagueId)`

**Interfaces:**

Subcommands (same auth as rollover — `assertCanConfigureBot`):

| Subcommand         | Options                          | Behavior                                                                                                           |
| ------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `set season_end`   | `date` string, optional `league` | Parse `YYYY-MM-DD` as UTC end of that calendar day (`T23:59:59.999Z`) or full ISO; reject past; set `seasonEndsAt` |
| `clear season_end` | optional `league`                | `seasonEndsAt = null`                                                                                              |
| `crunch start`     | optional `league`                | `crunchStartedAt = now` (idempotent message if already set)                                                        |
| `crunch clear`     | optional `league`                | `crunchStartedAt = null`                                                                                           |

Errors (exact):

- `That league is archived. Pick an active league.`
- `Could not parse that date. Use YYYY-MM-DD or a full date/time.`
- `Season end must be in the future.`

- [ ] **Step 1: Add parse helper + unit test**

```typescript
export function parseSeasonEndDate(raw: string, now = new Date()): Date {
  const trimmed = raw.trim();
  let date: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    date = new Date(`${trimmed}T23:59:59.999Z`);
  } else {
    date = new Date(trimmed);
  }
  if (Number.isNaN(date.getTime())) {
    throw new Error('Could not parse that date. Use YYYY-MM-DD or a full date/time.');
  }
  if (date.getTime() <= now.getTime()) {
    throw new Error('Season end must be in the future.');
  }
  return date;
}
```

- [ ] **Step 2: Wire slash subcommands + execute branches**
- [ ] **Step 3: Commit**

```bash
git add src/commands/league/league.ts src/services/league/
git commit -m "$(cat <<'EOF'
feat(league): add season end and crunch staff commands

EOF
)"
```

---

### Task 11: `/config set decay` + view

**Files:**

- Modify: `src/services/league/league-wc3stats.ts` — add `setDecayEnabled(leagueId, enabled)` and include decay fields in config view DTO
- Modify: `src/commands/config/config.ts`

**Interfaces:**

- Slash: `/config set decay` with required boolean `enabled`, optional `league`
- Auth: `assertCanConfigureBot`; reject archived
- View line examples:

```text
**Rating decay:** `on` · season ends <t:UNIX:F> · crunch active
**Rating decay:** `off`
```

- [ ] **Step 1: Setter + view wiring**
- [ ] **Step 2: Commit**

```bash
git add src/services/league/league-wc3stats.ts src/commands/config/config.ts
git commit -m "$(cat <<'EOF'
feat(config): toggle per-league rating decay

EOF
)"
```

---

### Task 12: `/rank` idle and crunch copy

**Files:**

- Modify: `src/commands/player/rank.ts` and/or rank embed builder in services

**Interfaces:**

When decay enabled and not calibrating:

- If in crunch: footer `Crunch week: −100 ki/day after 2 idle days (−200/day after 10).`
- Else if idle days > 10: `Inactive 11+ days: league ki decays −50/day (−100/day after 20 days) until you finish a game.`

Do **not** prize-filter `/rank` rank number.

- [ ] **Step 1: Add footer when conditions met**
- [ ] **Step 2: Commit**

```bash
git add src/commands/player/rank.ts
git commit -m "$(cat <<'EOF'
feat(rank): show idle decay and crunch footers

EOF
)"
```

---

### Task 13: Docs + openskill rule

**Files:**

- Create: `docs/discord/staff/a7-rating-decay.md`
- Modify: `docs/discord/staff/a5-admin-cheat-sheet.md`
- Modify: `docs/discord/public/06-rank-and-boards.md`
- Modify: `docs/discord/README.md` (add `a7` to staff list)
- Modify: `.cursor/rules/openskill-rating.mdc` (edge-case row for decay)
- Modify: `docs/superpowers/specs/2026-08-23-rating-decay-design.md` status → `Approved for implementation` / link plan

**Staff guide content (keep under Discord 2000 chars):**

- Mid-season decay summary
- `/config set decay`
- `/league set season_end` / `clear season_end`
- `/league crunch start` / `clear`
- Continue rollover = decay off by default
- Prize lock medals during crunch

**Player guide addition to `06-rank-and-boards.md`:**

- Idle decay after 10 days
- Crunch week + medals need a recent finished game

- [ ] **Step 1: Write docs + rule row**
- [ ] **Step 2: Commit**

```bash
git add docs/discord docs/superpowers/specs/2026-08-23-rating-decay-design.md .cursor/rules/openskill-rating.mdc
git commit -m "$(cat <<'EOF'
docs: document rating decay and season crunch

EOF
)"
```

---

### Task 14: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`  
Expected: PASS

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`  
Expected: PASS

- [ ] **Step 3: Spec coverage self-check**

Confirm implemented: mid-season tiers, crunch tiers, floor, streak cap, catch-up, batch, continue decay off, prize lock, commands, config, docs.

- [ ] **Step 4: No further commit unless fixes needed**

---

## Spec coverage checklist

| Spec requirement                            | Task |
| ------------------------------------------- | ---- |
| Schema + activity backfill                  | 1    |
| Pure μ decay math / tiers / floor / cap     | 2    |
| applyPendingDecay + batch                   | 3    |
| Daily UTC scheduler                         | 4    |
| Non-quit streak reset                       | 5    |
| Rank reset counters                         | 6    |
| Catch-up on reads                           | 7    |
| Prize lock medals                           | 8    |
| Continue `decayEnabled=false` + seed fields | 9    |
| season_end + crunch commands                | 10   |
| `/config set decay`                         | 11   |
| `/rank` copy                                | 12   |
| Staff/player docs + openskill rule          | 13   |
| Full verify                                 | 14   |
