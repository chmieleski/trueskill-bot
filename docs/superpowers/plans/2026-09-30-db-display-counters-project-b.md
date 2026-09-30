# Display Counters Shadow → Flip (Project B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist league-global display W/L/quit/grief/DC counters on `PlayerRating`, keep history as source of truth under shadow, then optionally flip reads via env flag — without changing OpenSkill apply or ki formula.

**Architecture:** New `PlayerRating` columns maintained in the same transactions as match/sanction/rank-reset writers; `loadMatchDisplayStatsByPlayer` compares history vs counters in shadow (warn on mismatch, return history); `DISPLAY_STATS_SOURCE=counters` switches readers after a clean shadow window.

**Tech Stack:** Prisma migrate, TypeScript ESM, Vitest, bot env + AWS SSM sync

**Spec:** `docs/superpowers/specs/2026-09-30-db-query-ingest-reduction-design.md` (Project B)  
**Depends on:** Project A optional but recommended first (ingest relief while shadow runs)

## Global Constraints

- Scope: `general`; every counter read/write keyed by `leagueId`
- Default `DISPLAY_STATS_SOURCE=history` until explicit flip
- Counter semantics **must** match `aggregateMatchDisplayStats` + `loadMatchDisplayRows` in `rank-reset-display.ts`
- OpenSkill μ/σ apply path untouched
- No hero / side W/L denorm in v1
- New env key requires full **env-aws-sync** checklist
- English-only logs; Conventional Commits; `pnpm run format:check` before PR

## File map

| File | Role |
| --- | --- |
| `packages/db/prisma/schema.prisma` | `PlayerRating` display counter columns |
| `packages/db/prisma/migrations/<ts>_player_rating_display_counters/` | Migration SQL |
| `apps/bot/src/services/rating/display-counters.ts` | Apply deltas / recompute / compare |
| `apps/bot/src/services/rating/display-counters.test.ts` | Unit tests |
| `apps/bot/src/services/rating/rank-reset-display.ts` | Shadow/flip read path |
| `apps/bot/src/config/env.ts` | `DISPLAY_STATS_SOURCE` |
| `.env.example`, `.cursor/rules/scripts-and-env.mdc` | Docs |
| `infra/aws/variables.tf`, `ssm.tf`, `terraform.tfvars.example` | SSM |
| `deploy/aws/refresh-env.sh` | Host env writer |
| `apps/bot/scripts/backfill-display-counters.ts` | One-off backfill |
| `apps/bot/scripts/verify-display-counters.ts` | Ops verify (exit 1 on mismatch) |

---

### Task 1: Prisma schema + migration

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (`PlayerRating`)
- Create: migration via Prisma

**Interfaces:**
- Produces: columns `displayWins`, `displayLosses`, `displayQuits`, `displayGriefs`, `displayDcs` (`Int @default(0)`)

- [ ] **Step 1: Add columns to schema**

```prisma
model PlayerRating {
  leagueId  String
  playerId  String
  mu          Float    @default(25.0)
  sigma       Float    @default(8.333)
  isNewPlayer              Boolean   @default(false)
  lastQualifyingActivityAt DateTime?
  idleDecayKiApplied       Int       @default(0)
  lastDecayAppliedAt       DateTime?
  /// Denormalized display W/L/Q/G/DC (rank-reset window). Shadowed vs MatchPlayer until flip.
  displayWins   Int @default(0)
  displayLosses Int @default(0)
  displayQuits  Int @default(0)
  displayGriefs Int @default(0)
  displayDcs    Int @default(0)
  updatedAt                DateTime  @updatedAt
  // ... relations unchanged
}
```

- [ ] **Step 2: Create migration**

```bash
cd /home/leski/www/bot && pnpm --filter @dbz/db exec prisma migrate dev --name player_rating_display_counters
```

Expected: migration SQL with `ADD COLUMN ... DEFAULT 0` for five ints; client regenerated.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(db): add PlayerRating display counter columns

EOF
)"
```

---

### Task 2: Pure counter helpers + unit tests

**Files:**
- Create: `apps/bot/src/services/rating/display-counters.ts`
- Create: `apps/bot/src/services/rating/display-counters.test.ts`
- Modify: `apps/bot/src/services/rating/index.ts` (exports)

**Interfaces:**
- Consumes: `PlayerMatchDisplayStats` from `rank-reset-display.ts`
- Produces:
  - `displayStatsFromCounters(row) → PlayerMatchDisplayStats`
  - `countersEqualStats(a, b) → boolean`
  - `recomputeDisplayCountersForPlayer(leagueId, playerId, db) → PlayerMatchDisplayStats` (history → write)

- [ ] **Step 1: Failing tests for mapping / equality**

```typescript
import { describe, expect, it } from 'vitest';
import {
  countersEqualStats,
  displayStatsFromCounters,
} from './display-counters.js';

describe('displayStatsFromCounters', () => {
  it('maps columns to PlayerMatchDisplayStats', () => {
    expect(
      displayStatsFromCounters({
        displayWins: 3,
        displayLosses: 2,
        displayQuits: 1,
        displayGriefs: 0,
        displayDcs: 2,
      }),
    ).toEqual({ games: 5, wins: 3, losses: 2, quits: 1, griefs: 0, dcs: 2 });
  });
});

describe('countersEqualStats', () => {
  it('returns true when equal', () => {
    const s = { games: 5, wins: 3, losses: 2, quits: 1, griefs: 0, dcs: 2 };
    expect(countersEqualStats(s, s)).toBe(true);
  });
  it('returns false when quits differ', () => {
    const a = { games: 1, wins: 1, losses: 0, quits: 0, griefs: 0, dcs: 0 };
    const b = { ...a, quits: 1 };
    expect(countersEqualStats(a, b)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

`pnpm --filter @dbz/bot exec vitest run src/services/rating/display-counters.test.ts`

- [ ] **Step 3: Implement helpers**

```typescript
import type { PrismaClient } from '@dbz/db';
import {
  loadMatchDisplayStatsByPlayer,
  type PlayerMatchDisplayStats,
} from './rank-reset-display.js';

export type DisplayCounterColumns = {
  displayWins: number;
  displayLosses: number;
  displayQuits: number;
  displayGriefs: number;
  displayDcs: number;
};

export function displayStatsFromCounters(row: DisplayCounterColumns): PlayerMatchDisplayStats {
  return {
    wins: row.displayWins,
    losses: row.displayLosses,
    games: row.displayWins + row.displayLosses,
    quits: row.displayQuits,
    griefs: row.displayGriefs,
    dcs: row.displayDcs,
  };
}

export function countersEqualStats(
  a: PlayerMatchDisplayStats,
  b: PlayerMatchDisplayStats,
): boolean {
  return (
    a.wins === b.wins &&
    a.losses === b.losses &&
    a.quits === b.quits &&
    a.griefs === b.griefs &&
    a.dcs === b.dcs
  );
}

export function counterColumnsFromStats(stats: PlayerMatchDisplayStats): DisplayCounterColumns {
  return {
    displayWins: stats.wins,
    displayLosses: stats.losses,
    displayQuits: stats.quits,
    displayGriefs: stats.griefs,
    displayDcs: stats.dcs,
  };
}

type Db = Pick<PrismaClient, 'playerRating' | 'playerRankReset' | 'matchPlayer'>;

/** Recompute from MatchPlayer history and persist (rank reset / backfill / repair). */
export async function recomputeDisplayCountersForPlayer(
  leagueId: string,
  playerId: string,
  db: Db,
): Promise<PlayerMatchDisplayStats> {
  const map = await loadMatchDisplayStatsByPlayer(leagueId, [playerId], db);
  const stats = map.get(playerId) ?? {
    games: 0,
    wins: 0,
    losses: 0,
    quits: 0,
    griefs: 0,
    dcs: 0,
  };
  await db.playerRating.update({
    where: { leagueId_playerId: { leagueId, playerId } },
    data: counterColumnsFromStats(stats),
  });
  return stats;
}
```

Avoid circular import if `rank-reset-display` later imports this module — keep `recompute` in `display-counters.ts` importing loaders is fine; do **not** import `display-counters` from the bottom of `rank-reset-display` until Task 4 (or inject compare helpers only upward).

- [ ] **Step 4: Tests PASS + commit**

```bash
git commit -m "$(cat <<'EOF'
feat(rating): add display counter mapping helpers

EOF
)"
```

---

### Task 3: Env flag + AWS sync

**Files:**
- Modify: `apps/bot/src/config/env.ts`
- Modify: `.env.example`
- Modify: `.cursor/rules/scripts-and-env.mdc`
- Modify: `infra/aws/variables.tf`, `infra/aws/ssm.tf`, `infra/aws/terraform.tfvars.example`
- Modify: `deploy/aws/refresh-env.sh`
- Test: env parse unit test if the project has one; otherwise add a small test next to env

**Interfaces:**
- Produces: `env.displayStatsSource: 'history' | 'counters'` default `'history'`

- [ ] **Step 1: Parse env**

```typescript
function parseDisplayStatsSource(raw: string | undefined): 'history' | 'counters' {
  const v = raw?.trim().toLowerCase();
  if (v === 'counters') return 'counters';
  return 'history';
}

// on exported env object:
displayStatsSource: parseDisplayStatsSource(process.env.DISPLAY_STATS_SOURCE),
```

- [ ] **Step 2: Docs + SSM**

`.env.example`:

```bash
# Display W/L source: history (default, MatchPlayer) | counters (PlayerRating denorm after shadow)
# DISPLAY_STATS_SOURCE=history
```

Add SSM `String` parameter default `history`, `refresh-env.sh` echo line, variables.tf default `"history"`, scripts-and-env table row.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(config): add DISPLAY_STATS_SOURCE history|counters flag

EOF
)"
```

Remind in PR: run `tofu apply` + refresh-env before relying on prod flag.

---

### Task 4: Shadow / flip in `loadMatchDisplayStatsByPlayer`

**Files:**
- Modify: `apps/bot/src/services/rating/rank-reset-display.ts`
- Modify: tests that mock this loader
- Create/extend: `rank-reset-display` or `display-counters` integration-style unit tests with mocked db

**Interfaces:**
- Consumes: `env.displayStatsSource`, counter columns on `playerRating`
- Produces: same `Map<string, PlayerMatchDisplayStats>` API

- [ ] **Step 1: Failing test — shadow returns history on mismatch and would log**

Use vi.mock logger or spy; when history wins=1 and counters wins=0 and source=history, returned map uses history.

- [ ] **Step 2: Implement read path**

Pseudocode:

```typescript
export async function loadMatchDisplayStatsByPlayer(...) {
  const history = aggregateMatchDisplayStats(...); // existing path

  if (env.displayStatsSource === 'counters') {
    const rows = await db.playerRating.findMany({
      where: { leagueId, ...(playerIds ? { playerId: { in: playerIds } } : {}) },
      select: {
        playerId: true,
        displayWins: true,
        displayLosses: true,
        displayQuits: true,
        displayGriefs: true,
        displayDcs: true,
      },
    });
    return new Map(rows.map((r) => [r.playerId, displayStatsFromCounters(r)]));
  }

  // shadow: compare when we can load counters
  const rows = await db.playerRating.findMany({ /* same select */ });
  for (const r of rows) {
    const h = history.get(r.playerId) ?? ZERO;
    const c = displayStatsFromCounters(r);
    if (!countersEqualStats(h, c)) {
      log.warn({ leagueId, playerId: r.playerId, history: h, counters: c }, 'display counter shadow mismatch');
    }
  }
  return history;
}
```

**Important:** When `playerIds` is undefined (full league), still OK for shadow. When source is `counters`, missing `PlayerRating` row → treat as zeros (same as missing history bucket).

Avoid double full-table scans in hot paths when Project A already passes playerIds.

- [ ] **Step 3: Tests PASS + commit**

```bash
git commit -m "$(cat <<'EOF'
feat(rating): shadow display counters against match history

EOF
)"
```

---

### Task 5: Writers — recompute on history-changing events

**Files (call `recomputeDisplayCountersForPlayer` inside existing txs):**
- Match complete / cancel paths (`match-report.ts`, cancel flows)
- Match correction (`match-correction.ts`)
- Manual sanction (`manual-sanction.ts`)
- Rank reset (`rank-reset.ts`) — **always recompute** (or zero then recompute) in the same transaction

**Preferred strategy (safer than incremental deltas):** after the transaction mutates `MatchPlayer` rows for affected `playerId`s, call `recomputeDisplayCountersForPlayer` for each affected player **using the transaction client**. This guarantees equality with history aggregator and avoids delta bugs.

- [ ] **Step 1: Failing integration-style tests**

For at least one path (e.g. complete match): after complete, `PlayerRating.displayWins/Losses` match `loadMatchDisplayStatsByPlayer` history aggregation for those players.

- [ ] **Step 2: Wire recompute**

Collect `playerIds` touched by the match/sanction/reset; after MatchPlayer writes, for each id:

```typescript
await recomputeDisplayCountersForPlayer(leagueId, playerId, tx);
```

Ensure `Db` type on recompute accepts transaction client (`playerRating` + `matchPlayer` + `playerRankReset`).

- [ ] **Step 3: Run match/rating/sanction/rank-reset test suites**

```bash
pnpm --filter @dbz/bot exec vitest run \
  src/services/match/ \
  src/services/rating/ \
  src/services/leaderboard/
```

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(rating): keep display counters in sync on match and reset writes

EOF
)"
```

---

### Task 6: Backfill + verify scripts

**Files:**
- Create: `apps/bot/scripts/backfill-display-counters.ts`
- Create: `apps/bot/scripts/verify-display-counters.ts`
- Optional package.json script entries under `@dbz/bot`

- [ ] **Step 1: Backfill script**

For each `PlayerRating` (`leagueId`, `playerId`): `recomputeDisplayCountersForPlayer`. Log progress every N rows. Idempotent.

Run locally against Docker or carefully against prod with maintenance window after migrate deploy.

- [ ] **Step 2: Verify script**

For each active league (or all), for each PlayerRating: load history stats vs counter columns; print mismatches; `process.exit(mismatches > 0 ? 1 : 0)`.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore(rating): add display counter backfill and verify scripts

EOF
)"
```

---

### Task 7: Deploy shadow → observe → flip

**Ops (not code):**

- [ ] Deploy migration + app with `DISPLAY_STATS_SOURCE=history`
- [ ] Run backfill once
- [ ] Run verify script — expect 0 mismatches
- [ ] Play several game nights; watch logs for `display counter shadow mismatch`
- [ ] Re-run verify; if still 0, set SSM `DISPLAY_STATS_SOURCE=counters`, refresh-env, restart bot
- [ ] Smoke `/rank` + leaderboard; keep rollback = set `history`

---

## Spec coverage (Project B)

| Spec item | Task |
| --- | --- |
| Schema counters on PlayerRating | 1 |
| Semantics = aggregator | 2, 5 |
| Writers same transaction | 5 |
| Shadow default | 4 |
| DISPLAY_STATS_SOURCE + AWS sync | 3 |
| Backfill + verify | 6 |
| Flip / rollback | 7 |
| No OpenSkill change | All |

## Risk notes

- Prefer **recompute** over incremental deltas (correctness > micro-savings on write path)
- Shadow temporarily **adds** a `playerRating` read alongside history — acceptable until flip removes history scan
- Rank reset must recompute or counters diverge permanently
