# DB Ingest Relief (Project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut Supabase Logs Ingest / Shared Pooler chatter without changing μ/ki, boards, or lobby semantics — via League decay cache, scoped history reads, and diff-based lobby roster writes.

**Architecture:** Process-local TTL+invalidate cache for League decay rows used by `applyPendingDecay*`; pass known `playerIds` into display-stats loaders on hot paths; replace `replaceMatchRoster` wipe with delete/update/insert diff inside the existing PENDING transaction.

**Tech Stack:** TypeScript ESM, Prisma, Vitest, existing rating/lobby services

**Spec:** `docs/superpowers/specs/2026-09-30-db-query-ingest-reduction-design.md` (Project A)

## Global Constraints

- Scope: `general` (no WC3-only imports in these modules)
- English-only logs/errors
- **No Prisma migration** in Project A
- **No production behavior change** for ki/W/L/quit/boards/lobby locks
- ESM imports use `.js` extension; named exports
- Conventional Commits; run `pnpm format:check` before PR
- Do not change translation keys

## File map

| File                                                             | Role                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| `apps/bot/src/services/rating/rating-decay-league-cache.ts`      | In-process League decay cache                         |
| `apps/bot/src/services/rating/rating-decay-league-cache.test.ts` | Cache unit tests                                      |
| `apps/bot/src/services/rating/rating-decay.ts`                   | Use cache in `applyPendingDecay`                      |
| `apps/bot/src/services/rating/index.ts`                          | Re-export invalidate helper if needed                 |
| `apps/bot/src/services/league/league-decay.ts`                   | Invalidate on every decay/season/crunch write         |
| `apps/bot/src/services/leaderboard/leaderboard.ts`               | Pass `playerIds` into `loadMatchDisplayStatsByPlayer` |
| `apps/bot/src/services/match/match-service.ts`                   | Diff-based `replaceMatchRoster`                       |
| `apps/bot/src/services/match/replace-match-roster.test.ts`       | Roster diff tests (new)                               |

---

### Task 1: League decay settings cache module

**Files:**

- Create: `apps/bot/src/services/rating/rating-decay-league-cache.ts`
- Create: `apps/bot/src/services/rating/rating-decay-league-cache.test.ts`
- Modify: `apps/bot/src/services/rating/index.ts` (export `invalidateDecayLeagueCache`, `DECAY_LEAGUE_CACHE_TTL_MS` if useful)

**Interfaces:**

- Consumes: `DECAY_SETTINGS_SELECT` from `decay-settings.ts`; Prisma `league.findUnique` via injected fetch
- Produces: `getDecayLeagueCached(leagueId, fetch)`, `invalidateDecayLeagueCache(leagueId | 'all')`, type `DecayLeagueCacheRow`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/bot/src/services/rating/rating-decay-league-cache.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DECAY_LEAGUE_CACHE_TTL_MS,
  getDecayLeagueCached,
  invalidateDecayLeagueCache,
  type DecayLeagueCacheRow,
} from './rating-decay-league-cache.js';

describe('decay league cache', () => {
  beforeEach(() => {
    invalidateDecayLeagueCache('all');
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const row = (id: string): DecayLeagueCacheRow => ({
    status: 'ACTIVE',
    decayEnabled: true,
    seasonEndsAt: null,
    crunchStartedAt: null,
    archivedAt: null,
    decayMidGraceDays: null,
    decayMidTier1Ki: null,
    decayMidTier2Ki: null,
    decayMidTier1SpanDays: null,
    decayMidStreakCapKi: null,
    decayCrunchGraceDays: null,
    decayCrunchTier1Ki: null,
    decayCrunchTier2Ki: null,
    decayCrunchTier1SpanDays: null,
    decayCrunchWindowDays: null,
    decayPrizeLockEnabled: null,
    decayPrizeLockMinGames: null,
  });

  it('fetches once then serves from cache', async () => {
    const fetch = vi.fn(async () => row('league-1'));
    const a = await getDecayLeagueCached('league-1', fetch);
    const b = await getDecayLeagueCached('league-1', fetch);
    expect(a).toEqual(row('league-1'));
    expect(b).toEqual(row('league-1'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refetches after invalidate', async () => {
    const fetch = vi.fn(async () => row('league-1'));
    await getDecayLeagueCached('league-1', fetch);
    invalidateDecayLeagueCache('league-1');
    await getDecayLeagueCached('league-1', fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refetches after TTL', async () => {
    const fetch = vi.fn(async () => row('league-1'));
    await getDecayLeagueCached('league-1', fetch);
    vi.advanceTimersByTime(DECAY_LEAGUE_CACHE_TTL_MS + 1);
    await getDecayLeagueCached('league-1', fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('caches null miss briefly (no league)', async () => {
    const fetch = vi.fn(async () => null);
    await getDecayLeagueCached('missing', fetch);
    await getDecayLeagueCached('missing', fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/leski/www/bot && pnpm --filter @dbz/bot exec vitest run src/services/rating/rating-decay-league-cache.test.ts`

Expected: FAIL (module missing)

- [ ] **Step 3: Implement cache module**

```typescript
// apps/bot/src/services/rating/rating-decay-league-cache.ts
import type { LeagueStatus } from '@dbz/db';
import { DECAY_SETTINGS_SELECT } from './decay-settings.js';

/** Backstop TTL when a writer forgets to invalidate (ms). */
export const DECAY_LEAGUE_CACHE_TTL_MS = 60_000;

export type DecayLeagueCacheRow = {
  status: LeagueStatus;
  decayEnabled: boolean;
  seasonEndsAt: Date | null;
  crunchStartedAt: Date | null;
  archivedAt: Date | null;
} & {
  [K in keyof typeof DECAY_SETTINGS_SELECT]: number | boolean | null;
};

type CacheEntry = {
  value: DecayLeagueCacheRow | null;
  fetchedAtMs: number;
};

const cache = new Map<string, CacheEntry>();

export function invalidateDecayLeagueCache(leagueId: string | 'all'): void {
  if (leagueId === 'all') {
    cache.clear();
    return;
  }
  cache.delete(leagueId);
}

/**
 * Return cached League decay row, or fetch+store.
 * `fetch` should use the same select shape as applyPendingDecay.
 */
export async function getDecayLeagueCached(
  leagueId: string,
  fetch: () => Promise<DecayLeagueCacheRow | null>,
  nowMs: number = Date.now(),
): Promise<DecayLeagueCacheRow | null> {
  const hit = cache.get(leagueId);
  if (hit && nowMs - hit.fetchedAtMs < DECAY_LEAGUE_CACHE_TTL_MS) {
    return hit.value;
  }
  const value = await fetch();
  cache.set(leagueId, { value, fetchedAtMs: nowMs });
  return value;
}
```

Adjust the mapped settings type if Prisma types complain — prefer an explicit interface matching `applyPendingDecay`'s select.

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm --filter @dbz/bot exec vitest run src/services/rating/rating-decay-league-cache.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/services/rating/rating-decay-league-cache.ts \
  apps/bot/src/services/rating/rating-decay-league-cache.test.ts \
  apps/bot/src/services/rating/index.ts
git commit -m "$(cat <<'EOF'
feat(rating): add in-process league decay settings cache

EOF
)"
```

---

### Task 2: Wire cache into `applyPendingDecay` + invalidate writers

**Files:**

- Modify: `apps/bot/src/services/rating/rating-decay.ts`
- Modify: `apps/bot/src/services/league/league-decay.ts`
- Modify: `apps/bot/src/services/rating/rating-decay-apply.test.ts` (mocks still work via fetch path)
- Test: existing `rating-decay-apply.test.ts` must stay green

**Interfaces:**

- Consumes: `getDecayLeagueCached` from Task 1
- Produces: unchanged `applyPendingDecay` / `applyPendingDecayForPlayers` signatures

- [ ] **Step 1: Replace League findUnique in `applyPendingDecay` with cache**

In `rating-decay.ts`, replace the `db.league.findUnique` half of the `Promise.all` with:

```typescript
import { getDecayLeagueCached } from './rating-decay-league-cache.js';

// inside applyPendingDecay:
const [league, rating] = await Promise.all([
  getDecayLeagueCached(leagueId, () =>
    db.league.findUnique({
      where: { id: leagueId },
      select: {
        status: true,
        decayEnabled: true,
        seasonEndsAt: true,
        crunchStartedAt: true,
        archivedAt: true,
        ...DECAY_SETTINGS_SELECT,
      },
    }),
  ),
  db.playerRating.findUnique({
    where: { leagueId_playerId: { leagueId, playerId } },
    select: {
      mu: true,
      sigma: true,
      isNewPlayer: true,
      lastQualifyingActivityAt: true,
      idleDecayKiApplied: true,
      lastDecayAppliedAt: true,
    },
  }),
]);
```

Keep all post-fetch logic identical.

- [ ] **Step 2: Invalidate after every League decay-related write in `league-decay.ts`**

Import `invalidateDecayLeagueCache`. After each successful `prisma.league.update` in:

- `setLeagueSeasonEndsAt`
- `startLeagueCrunch`
- `clearLeagueCrunch`
- `setDecayEnabled`
- `setDecayModeSetting` / `clearDecayModeSetting`
- `setDecayStreakCap` / `clearDecayStreakCap`
- `setDecayCrunchWindow` / `clearDecayCrunchWindow`
- `setDecayPrizeLock` / `clearDecayPrizeLock`
- `setDecayPrizeLockMinGames` / `clearDecayPrizeLockMinGames`
- any preset applier that updates League

Call: `invalidateDecayLeagueCache(leagueId)`.

Also search for other writers of these columns (league rollover / archive). If they update decay-relevant fields, invalidate there too (`invalidateDecayLeagueCache(leagueId)` or `'all'` if many).

- [ ] **Step 3: Run decay tests**

Run:

```bash
pnpm --filter @dbz/bot exec vitest run \
  src/services/rating/rating-decay-apply.test.ts \
  src/services/rating/rating-decay.test.ts \
  src/services/league/league-decay.test.ts \
  src/services/rating/rating-decay-league-cache.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(rating): serve decay league rows from process cache

EOF
)"
```

---

### Task 3: Scope leaderboard display-stats to known player ids

**Files:**

- Modify: `apps/bot/src/services/leaderboard/leaderboard.ts` (`loadEligibleOverallRows`)
- Grep and fix any other hot caller of `loadMatchDisplayStatsByPlayer(leagueId)` without ids that already has a player id list
- Test: existing leaderboard tests

**Interfaces:**

- Consumes: `loadMatchDisplayStatsByPlayer(leagueId, playerIds)`
- Produces: same leaderboard entry shape

- [ ] **Step 1: Write / extend a regression test**

If `leaderboard.test.ts` mocks `loadMatchDisplayStatsByPlayer`, assert it is called with the player id array from ratings, not bare `leagueId` only.

Example expectation:

```typescript
expect(loadMatchDisplayStatsByPlayer).toHaveBeenCalledWith(
  'league-1',
  expect.arrayContaining(['p1', 'p2']),
);
```

(Adjust to actual mock setup in the file.)

- [ ] **Step 2: Run test — expect FAIL** (still called with one arg)

- [ ] **Step 3: Fix `loadEligibleOverallRows`**

```typescript
const ratingIds = await prisma.playerRating.findMany({
  where: { leagueId },
  select: { playerId: true },
});
const playerIds = ratingIds.map((row) => row.playerId);
await applyPendingDecayForPlayers(leagueId, playerIds);

const [ratings, displayStatsByPlayer, league] = await Promise.all([
  prisma.playerRating.findMany({
    where: { leagueId },
    include: {
      player: { select: { id: true, username: true, discordId: true } },
    },
  }),
  loadMatchDisplayStatsByPlayer(leagueId, playerIds),
  prisma.league.findUnique({
    where: { id: leagueId },
    select: {
      status: true,
      decayEnabled: true,
      seasonEndsAt: true,
      crunchStartedAt: true,
      archivedAt: true,
      ...DECAY_SETTINGS_SELECT,
    },
  }),
]);
```

- [ ] **Step 4: Audit remaining call sites**

Run: `rg "loadMatchDisplayStatsByPlayer\\(" apps/bot/src -n`

For each call without `playerIds` where the caller already has ids, pass them. Leave intentional full-league scans only where the product needs every player and ids are unknown (document in PR). **Do not** change `/hero` without a player — that league-wide hero board is intentional (remaining cost until Project B / later aggregate).

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @dbz/bot exec vitest run src/services/leaderboard/
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git commit -m "$(cat <<'EOF'
perf(leaderboard): scope match display stats to rating player ids

EOF
)"
```

---

### Task 4: Diff-based `replaceMatchRoster`

**Files:**

- Modify: `apps/bot/src/services/match/match-service.ts` (`replaceMatchRoster`)
- Create: `apps/bot/src/services/match/replace-match-roster.test.ts`

**Interfaces:**

- Consumes: existing `replaceMatchRoster(matchId, players, options?)` signature
- Produces: same `MatchWithPlayers` return; same errors for missing/non-PENDING matches

- [ ] **Step 1: Write failing behavioral tests**

Use Prisma mock or existing match-service test patterns. Cover:

1. Empty lobby → two players: creates two rows (no delete needed)
2. Two players → remove one: deletes only the removed `playerId`
3. Same playerId stays in slot with nick/team unchanged: **update** path (or no-op), not delete+recreate — assert `deleteMany` not called for full wipe; prefer asserting `delete`/`update`/`create` call shapes on tx mock
4. Locked pair: player A locked on slot 1 survives refresh that keeps A on slot 1
5. Non-PENDING match: throws, no writes

Sketch (adapt to project mock style):

```typescript
describe('replaceMatchRoster diff', () => {
  it('does not wipe all rows when one slot changes', async () => {
    // arrange PENDING match with players at slots 1 and 2
    // act: replace with slot 1 same player, slot 2 different player
    // assert: delete only old slot-2 playerId; create/update for new slot-2; slot-1 not deleted
  });

  it('preserves locked pair across refresh', async () => {
    // existing locked (playerId, slot); incoming same pair → locked true
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL** (current wipe behavior)

- [ ] **Step 3: Implement diff inside the transaction**

Replace the block that does `deleteMany` + `createMany` with logic equivalent to:

```typescript
const previousRows = await tx.matchPlayer.findMany({
  where: { matchId },
  select: {
    playerId: true,
    slot: true,
    team: true,
    heroId: true,
    locked: true,
    isQuitter: true,
    isGriefer: true,
  },
});
const previousLockedPairs = new Set(
  previousRows
    .filter((row) => row.locked)
    .map((row) => matchPlayerLockPairKey(row.playerId, row.slot)),
);
const incomingLockedBySlot = new Map(
  roster.map((player) => [player.slot, player.locked === true] as const),
);

const resolved = await resolvePlayersInTx(tx, roster, existing.leagueId, profile);
const nextByPlayerId = new Map(resolved.map((e) => [e.playerId, e]));
const prevByPlayerId = new Map(previousRows.map((r) => [r.playerId, r]));

const toDelete = previousRows.filter((r) => !nextByPlayerId.has(r.playerId));
if (toDelete.length > 0) {
  await tx.matchPlayer.deleteMany({
    where: {
      matchId,
      playerId: { in: toDelete.map((r) => r.playerId) },
    },
  });
}

for (const entry of resolved) {
  const locked = reconcileMatchPlayerLocked(
    previousLockedPairs,
    entry.playerId,
    entry.slot,
    incomingLockedBySlot.get(entry.slot) === true,
  );
  const prev = prevByPlayerId.get(entry.playerId);
  const data = {
    team: entry.team,
    slot: entry.slot,
    heroId: entry.heroId,
    result: null as null,
    isQuitter: entry.isQuitter === true,
    isGriefer: false,
    locked,
  };
  if (!prev) {
    await tx.matchPlayer.create({
      data: { matchId, playerId: entry.playerId, ...data },
    });
  } else if (
    prev.team !== data.team ||
    prev.slot !== data.slot ||
    prev.heroId !== data.heroId ||
    prev.isQuitter !== data.isQuitter ||
    prev.locked !== data.locked
  ) {
    await tx.matchPlayer.update({
      where: { matchId_playerId: { matchId, playerId: entry.playerId } },
      data,
    });
  }
}
```

Keep hero-catalog checks, `assertValidSlots`, `markLobbyRosterAuthority`, and final `findUniqueOrThrow` include identical.

**Edge case:** If the product allows the same human to move slots by wiping playerId identity incorrectly — current model is one row per `(matchId, playerId)`. Diff by `playerId` matches today’s createMany keys. If a slot swap exchanges two playerIds, both rows update — no delete.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @dbz/bot exec vitest run src/services/match/replace-match-roster.test.ts
pnpm --filter @dbz/bot exec vitest run src/services/lobby/
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
perf(lobby): diff match roster instead of full wipe

EOF
)"
```

---

### Task 5: Format, typecheck, PR readiness

- [ ] **Step 1: Format + typecheck**

```bash
cd /home/leski/www/bot && pnpm run format:check
pnpm --filter @dbz/bot typecheck
pnpm --filter @dbz/bot exec vitest run \
  src/services/rating/rating-decay-league-cache.test.ts \
  src/services/rating/rating-decay-apply.test.ts \
  src/services/leaderboard/ \
  src/services/match/replace-match-roster.test.ts
```

If format fails: `pnpm run format` and include in commit.

- [ ] **Step 2: Manual smoke checklist (human)**

- `/rank` for a linked player (decay footer unchanged when applicable)
- Leaderboard show overall
- Lobby OCR / wc3stats refresh keeps locks
- `/hero` with and without player nick (league-wide still works)

- [ ] **Step 3: Open PR** (when asked)

Title: `perf(db): cut league cache misses and lobby roster wipe churn`

Body: link spec; note Project B counters still follow.

---

## Spec coverage (Project A)

| Spec item                                | Task |
| ---------------------------------------- | ---- |
| A1 League decay cache + TTL + invalidate | 1–2  |
| A2 Scope history reads / pass playerIds  | 3    |
| A3 replaceMatchRoster diff               | 4    |
| No migration / no behavior change        | All  |
| Tests + smoke                            | 1–5  |
