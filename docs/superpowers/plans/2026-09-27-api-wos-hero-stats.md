# WOS hero & match combat stats HTTP API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose league Bearer-authenticated `GET` endpoints for WOS hero combat aggregates (all / last-N / time range) and per-match player stats, richer than Discord embeds.

**Architecture:** Thin routes under `apps/bot/src/api/` reuse league API token auth. A new `api-hero-combat-stats` service loads full `MatchPlayerStats` rows, aggregates avg+sum, and resolves items — without changing Discord embed totals. `hero-stats.ts` stays Discord-facing; shared pieces (`filterRowsToLastNMatches`, `normalizeHeroNameKey`, hero selection, item catalog) are imported.

**Tech Stack:** Node.js ESM (`node:http`), TypeScript, Prisma/PostgreSQL, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-27-api-wos-hero-stats-design.md`

## Global Constraints

- Scope: `game:warcraft3_wos` (stats/gate/catalogs) + `general` (HTTP shell, bearer auth).
- English-only API error strings.
- League tenancy: every read filtered by `leagueId` from the token; never cross-league.
- WOS gate: `getGameProfile(gameId).postMatchStats === 'wos2_bot_v1'` else `403`.
- No new env / SSM keys; no HTTP framework; ESM `.js` imports; named exports; Prisma from `apps/bot/src/lib/prisma.ts`.
- Do not change Discord embed field shapes.
- Conventional Commits; run `pnpm format:check` / package Prettier before PR.
- Prefer a feature branch (e.g. `feat/api-wos-hero-stats`); do not commit unrelated web/impeccable dirt.

---

## File map

| File                                                         | Responsibility                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `apps/bot/src/api/league-auth.ts`                            | Bearer → league + WOS gate; returns league or sends 401/403   |
| `apps/bot/src/api/parse-query.ts`                            | Parse URL search params for hero stats query                  |
| `apps/bot/src/api/parse-query.test.ts`                       | Unit tests for scope / games / dates / clamps                 |
| `apps/bot/src/services/player/api-hero-combat-stats.ts`      | Types, aggregate helpers, loaders for hero + match API        |
| `apps/bot/src/services/player/api-hero-combat-stats.test.ts` | Pure aggregate + filter unit tests                            |
| `apps/bot/src/services/player/wos-hero-names.ts`             | Add `listWosHeroesForLeague` returning `{ objectId, name }[]` |
| `apps/bot/src/services/player/wos-hero-names.test.ts`        | Test catalog listing shape                                    |
| `apps/bot/src/services/game/game-hero-catalog.ts`            | Add `resolveHeroSelectionByObjectId`                          |
| `apps/bot/src/services/game/game-hero-catalog.test.ts`       | ObjectId resolve tests                                        |
| `apps/bot/src/api/routes/heroes.ts`                          | `GET /v1/heroes`, `GET /v1/heroes/:heroKey/stats`             |
| `apps/bot/src/api/routes/match-stats.ts`                     | `GET /v1/matches/:matchId/stats`                              |
| `apps/bot/src/api/http-server.ts`                            | Dispatch new routes before 404                                |
| `apps/bot/src/api/wos-hero-stats.route.test.ts`              | Route-level auth / validation / happy-path tests              |
| `apps/bot/src/api/routes/wos-report.ts`                      | Optionally refactor to use shared league-auth                 |
| `docs/api/wos-hero-stats.md`                                 | Integrator guide                                              |
| `docs/api/wos-match-upload.md`                               | Cross-link to hero stats guide                                |

---

### Task 1: Query parsing for hero stats windows

**Files:**

- Create: `apps/bot/src/api/parse-query.ts`
- Create: `apps/bot/src/api/parse-query.test.ts`

**Interfaces:**

- Produces:

```typescript
export type ApiHeroStatsScope = 'all' | 'last' | 'range' | 'both';

export type ApiHeroStatsQuery = {
  scope: ApiHeroStatsScope;
  games: number; // 1–100, default 20
  from: Date | null; // required when scope === 'range'
  to: Date | null; // exclusive end; null means "now" at load time when scope === 'range'
  recentLimit: number; // 1–50, default 20
  topPlayers: number; // 0–25, default 5
};

export type ParseApiHeroStatsQueryResult =
  { ok: true; value: ApiHeroStatsQuery } | { ok: false; error: string };

/** Parse `URLSearchParams` from the request URL into a validated query. */
export function parseApiHeroStatsQuery(params: URLSearchParams): ParseApiHeroStatsQueryResult;
```

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import { parseApiHeroStatsQuery } from './parse-query.js';

describe('parseApiHeroStatsQuery', () => {
  it('defaults to both / games 20 / recentLimit 20 / topPlayers 5', () => {
    const result = parseApiHeroStatsQuery(new URLSearchParams());
    expect(result).toEqual({
      ok: true,
      value: {
        scope: 'both',
        games: 20,
        from: null,
        to: null,
        recentLimit: 20,
        topPlayers: 5,
      },
    });
  });

  it('rejects unknown scope', () => {
    const result = parseApiHeroStatsQuery(new URLSearchParams('scope=week'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/scope/i);
    }
  });

  it('requires from when scope=range', () => {
    const result = parseApiHeroStatsQuery(new URLSearchParams('scope=range'));
    expect(result.ok).toBe(false);
  });

  it('parses range from/to ISO dates', () => {
    const result = parseApiHeroStatsQuery(
      new URLSearchParams('scope=range&from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.from?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(result.value.to?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    }
  });

  it('rejects from >= to', () => {
    const result = parseApiHeroStatsQuery(
      new URLSearchParams('scope=range&from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z'),
    );
    expect(result.ok).toBe(false);
  });

  it('clamps games to 1–100', () => {
    expect(parseApiHeroStatsQuery(new URLSearchParams('games=0')).ok).toBe(false);
    expect(parseApiHeroStatsQuery(new URLSearchParams('games=101')).ok).toBe(false);
    const ok = parseApiHeroStatsQuery(new URLSearchParams('scope=last&games=50'));
    expect(ok).toMatchObject({ ok: true, value: { games: 50, scope: 'last' } });
  });

  it('rejects from/to when scope is not range', () => {
    const result = parseApiHeroStatsQuery(
      new URLSearchParams('scope=all&from=2026-01-01T00:00:00.000Z'),
    );
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/bot && pnpm exec vitest run src/api/parse-query.test.ts`

Expected: FAIL (module not found)

- [ ] **Step 3: Implement `parseApiHeroStatsQuery`**

Parse optional ints with `Number(...)` + `Number.isInteger`; reject non-integers. Parse dates with `new Date(iso)` and reject invalid. Defaults per Interfaces. If `from` or `to` is present when `scope !== 'range'`, return `{ ok: false, error: '...' }` so clients cannot assume a time filter applied.

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd apps/bot && pnpm exec vitest run src/api/parse-query.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/api/parse-query.ts apps/bot/src/api/parse-query.test.ts
git commit -m "feat(api): parse WOS hero stats query windows"
```

---

### Task 2: Pure combat aggregates (avg + sum + top players)

**Files:**

- Create: `apps/bot/src/services/player/api-hero-combat-stats.ts` (types + pure helpers only in this task)
- Create: `apps/bot/src/services/player/api-hero-combat-stats.test.ts`

**Interfaces:**

- Produces:

```typescript
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
  itemObjectIds: number[]; // non-zero slots in order 1–6
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

/** Filter rows with completedAt in [from, to). Null completedAt excluded from range. */
export function filterRowsToCompletedAtRange(
  rows: ApiCombatRow[],
  from: Date,
  to: Date,
): ApiCombatRow[];

/** Aggregate one window; topPlayersLimit 0 → empty topPlayers. Min 3 games for top list. */
export function aggregateApiHeroWindow(
  rows: ApiCombatRow[],
  topPlayersLimit: number,
): ApiHeroWindowAggregate;

/** Map item slots to API items using a name map (missing → name: null). */
export function mapItemSlots(
  objectIds: number[],
  names: Map<number, string>,
): Array<{ objectId: number; name: string | null }>;
```

Reuse `filterRowsToLastNMatches` from `hero-stats.js` and `winRatePercent` from `rank-reset-display.js`. Prefer exporting `formatKda` from `hero-stats.ts` if that file is touched; otherwise copy the 5-line helper into the new module.

- [ ] **Step 1: Write failing unit tests** for empty rows (`games` 0, null WR, zeros 0), one WIN + one LOSS averages/sums, range filter excluding null `completedAt`, topPlayers min-3 and limit 0.

- [ ] **Step 2: Run — expect FAIL**

Run: `cd apps/bot && pnpm exec vitest run src/services/player/api-hero-combat-stats.test.ts`

- [ ] **Step 3: Implement pure helpers** in `api-hero-combat-stats.ts`

Averages: `Math.round(mean(...))` like Discord. Window `kda` uses total kills/deaths.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/services/player/api-hero-combat-stats.ts \
  apps/bot/src/services/player/api-hero-combat-stats.test.ts \
  apps/bot/src/services/player/hero-stats.ts
git commit -m "feat(api): add WOS combat stats aggregate helpers"
```

---

### Task 3: Hero list with objectIds + resolve by objectId

**Files:**

- Modify: `apps/bot/src/services/player/wos-hero-names.ts`
- Create: `apps/bot/src/services/player/wos-hero-names.test.ts`
- Modify: `apps/bot/src/services/game/game-hero-catalog.ts`
- Modify or create: `apps/bot/src/services/game/game-hero-catalog.test.ts`

**Interfaces:**

- Produces:

```typescript
export type WosHeroListEntry = {
  objectId: number | null;
  name: string;
};

/** Distinct heroes in completed league matches; sorted by name. */
export async function listWosHeroesForLeague(
  leagueId: string,
  gameId: string,
): Promise<WosHeroListEntry[]>;

/** Resolve selection from a numeric WC3 object id for this game/league. */
export async function resolveHeroSelectionByObjectId(
  gameId: string,
  leagueId: string,
  objectId: number,
): Promise<HeroSelection | null>;
```

`listWosHeroNamesForLeague` should call `listWosHeroesForLeague` and map to names (DRY).

`resolveHeroSelectionByObjectId`:

1. `gameHero.findUnique({ where: { gameId_objectId: { gameId, objectId } } })` → selection with catalog name.
2. Else any completed league stats row with that `heroObjectId` → `formatHeroDisplayName`.
3. Else `null`.

- [ ] **Step 1: Write failing tests** (mock prisma following existing service test patterns).

- [ ] **Step 2: Implement**

- [ ] **Step 3: Run tests**

Run: `cd apps/bot && pnpm exec vitest run src/services/player/wos-hero-names.test.ts src/services/game/game-hero-catalog.test.ts`

- [ ] **Step 4: Commit**

```bash
git add apps/bot/src/services/player/wos-hero-names.ts \
  apps/bot/src/services/player/wos-hero-names.test.ts \
  apps/bot/src/services/game/game-hero-catalog.ts \
  apps/bot/src/services/game/game-hero-catalog.test.ts
git commit -m "feat(wos): list heroes with objectIds for API"
```

---

### Task 4: Loaders — hero combat stats + match combat stats

**Files:**

- Modify: `apps/bot/src/services/player/api-hero-combat-stats.ts` (add async loaders)
- Modify: `apps/bot/src/services/player/api-hero-combat-stats.test.ts`

**Interfaces:**

- Produces:

```typescript
export type ApiHeroStatsResponse = {
  leagueId: string;
  hero: { objectId: number | null; name: string };
  windows: Partial<Record<'all' | 'last' | 'range', ApiHeroWindowAggregate>>;
  recentGames: Array<{
    matchId: string;
    playerId: string;
    username: string;
    result: 'WIN' | 'LOSS';
    completedAt: string | null;
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
    items: Array<{ objectId: number; name: string | null }>;
  }>;
};

export async function loadApiHeroCombatStats(input: {
  leagueId: string;
  gameId: string;
  heroKey: string;
  query: ApiHeroStatsQuery;
}): Promise<ApiHeroStatsResponse | null>;

export type ApiMatchStatsResponse = {
  matchId: string;
  leagueId: string;
  status: string;
  externalId: string | null;
  completedAt: string | null;
  players: Array<{
    playerId: string;
    username: string;
    team: number;
    slot: number;
    result: 'WIN' | 'LOSS' | 'DRAW' | null;
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
    items: Array<{ objectId: number; name: string | null }>;
  }>;
};

export async function loadApiMatchCombatStats(input: {
  leagueId: string;
  gameId: string;
  matchId: string;
}): Promise<ApiMatchStatsResponse | null>;
```

**Loader rules:**

1. Decode `heroKey` with `decodeURIComponent`. If `/^\d+$/` → `resolveHeroSelectionByObjectId`; else `resolveHeroSelection(gameId, leagueId, heroKey)`.
2. If selection null → return null.
3. Query completed WIN/LOSS rows for league with full stats select (`damagePhys`…`itemSlot6`).
4. Filter with `statsRowMatchesHeroSelection`.
5. If zero rows → return null (`404`).
6. Build windows per `query.scope` using Task 2 helpers + `filterRowsToLastNMatches` / `filterRowsToCompletedAtRange` (`to` default `new Date()` when null).
7. Resolve item names once via `resolveItemNames`.
8. Match loader: find match by `{ id, leagueId }`; include players + stats + report; **omit** players without `stats`; ISO-serialize dates.

Export a pure `mapPrismaCombatRows` (or equivalent) so mapping can be unit-tested without a live DB.

- [ ] **Step 1: Implement loaders + mapping helpers with tests for mapping/item slots**

- [ ] **Step 2: Run**

Run: `cd apps/bot && pnpm exec vitest run src/services/player/api-hero-combat-stats.test.ts`

- [ ] **Step 3: Commit**

```bash
git add apps/bot/src/services/player/api-hero-combat-stats.ts \
  apps/bot/src/services/player/api-hero-combat-stats.test.ts
git commit -m "feat(api): load WOS hero and match combat stats"
```

---

### Task 5: Shared league Bearer + WOS gate helper

**Files:**

- Create: `apps/bot/src/api/league-auth.ts`
- Create: `apps/bot/src/api/league-auth.test.ts`
- Modify: `apps/bot/src/api/routes/wos-report.ts` (optional refactor; behavior unchanged)

**Interfaces:**

```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LeagueApiTokenResolved } from '../services/league/league-api-token.js';

export type RequireLeagueResult = { ok: true; league: LeagueApiTokenResolved } | { ok: false };

/**
 * Extract Bearer, resolve token, optionally require WOS.
 * Sends 401/403 via sendJson on failure.
 */
export async function requireLeagueApiAuth(
  req: IncomingMessage,
  res: ServerResponse,
  resolveToken: (plaintext: string) => Promise<LeagueApiTokenResolved | null>,
  options: { requireWos: boolean },
): Promise<RequireLeagueResult>;
```

WOS check: `getGameProfile(league.gameId).postMatchStats === 'wos2_bot_v1'` via `domain/game-profile.js`.

- [ ] **Step 1: Tests** — missing header → 401; bad token → 401; UDBR `gameId` → 403 when `requireWos: true`; WOS → ok.

Use mock `res` like `wos-report.route.test.ts`.

- [ ] **Step 2: Implement + optionally refactor wos-report to use it with `requireWos: true`**

- [ ] **Step 3: Run**

Run: `cd apps/bot && pnpm exec vitest run src/api/league-auth.test.ts src/api/wos-report.route.test.ts`

- [ ] **Step 4: Commit**

```bash
git add apps/bot/src/api/league-auth.ts apps/bot/src/api/league-auth.test.ts \
  apps/bot/src/api/routes/wos-report.ts
git commit -m "feat(api): share league bearer auth and WOS gate"
```

---

### Task 6: HTTP routes + dispatcher

**Files:**

- Create: `apps/bot/src/api/routes/heroes.ts`
- Create: `apps/bot/src/api/routes/match-stats.ts`
- Modify: `apps/bot/src/api/http-server.ts`
- Create: `apps/bot/src/api/wos-hero-stats.route.test.ts`

**Path matching:**

- Exact: `GET /v1/heroes`
- Pattern: `^/v1/heroes/([^/]+)/stats$` → decode group 1 as `heroKey`
- Pattern: `^/v1/matches/([^/]+)/stats$` → `matchId`
- Wrong method on matched path → `404` `{ error: 'Not Found' }`

**Handler flow (heroes list):**

1. `requireLeagueApiAuth(..., { requireWos: true })`
2. `listWosHeroesForLeague(league.leagueId, league.gameId)`
3. `200 { leagueId, heroes }`

**Handler flow (hero stats):**

1. Auth + WOS
2. `parseApiHeroStatsQuery` from URL search params → `400` on failure
3. `loadApiHeroCombatStats(...)` → `404` if null
4. `200` body

**Handler flow (match stats):**

1. Auth + WOS
2. `loadApiMatchCombatStats` → `404` if null
3. `200` body

**Wire `http-server.ts`:**

```typescript
const handled =
  (await handleWosReportRoute(req, res, deps)) ||
  (await handleHeroesRoutes(req, res, deps)) ||
  (await handleMatchStatsRoute(req, res, deps));
if (!handled) {
  sendJson(res, 404, { error: 'Not Found' });
}
```

Pass `deps.resolveToken` into route handlers. Mock loaders with `vi.mock` in route tests.

- [ ] **Step 1: Write route tests**

  - 401 without auth on `/v1/heroes`
  - 403 when resolveToken returns `gameId: 'warcraft3_udbr'`
  - 400 on `scope=range` without `from`
  - 404 unknown hero (loader returns null)
  - 200 hero stats happy path
  - 200 match stats happy path
  - 404 match wrong league

- [ ] **Step 2: Implement routes + dispatcher**

- [ ] **Step 3: Run**

Run: `cd apps/bot && pnpm exec vitest run src/api/wos-hero-stats.route.test.ts src/api/wos-report.route.test.ts`

- [ ] **Step 4: Commit**

```bash
git add apps/bot/src/api/routes/heroes.ts apps/bot/src/api/routes/match-stats.ts \
  apps/bot/src/api/http-server.ts apps/bot/src/api/wos-hero-stats.route.test.ts
git commit -m "feat(api): add GET heroes and match combat stats routes"
```

---

### Task 7: Integrator docs

**Files:**

- Create: `docs/api/wos-hero-stats.md`
- Modify: `docs/api/wos-match-upload.md` — add a short “Related APIs” link

**Doc contents:**

- Base URL / auth (same as upload guide)
- Three endpoints with query params table (`scope`, `games`, `from`, `to`, `recentLimit`, `topPlayers`)
- Example `curl` for each
- Error table
- Note: richer than Discord; league-wide aggregates ignore rank reset
- Link to design spec

- [ ] **Step 1: Write the markdown**

- [ ] **Step 2: Commit**

```bash
git add docs/api/wos-hero-stats.md docs/api/wos-match-upload.md
git commit -m "docs(api): document WOS hero and match stats endpoints"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full bot tests for touched areas**

Run: `cd apps/bot && pnpm exec vitest run src/api src/services/player/api-hero-combat-stats.test.ts src/services/player/wos-hero-names.test.ts src/services/game/game-hero-catalog.test.ts`

Expected: PASS

- [ ] **Step 2: Typecheck**

Run: `cd /home/leski/www/bot && pnpm --filter @dbz/bot typecheck`

Expected: PASS

- [ ] **Step 3: Format check**

Run: `cd /home/leski/www/bot && pnpm format:check`

Fix with `pnpm format` if needed; commit style-only if dirty.

- [ ] **Step 4: Confirm Discord hero embed tests still pass**

Run: `cd apps/bot && pnpm exec vitest run src/services/player/hero-stats.test.ts src/services/player/hero-stats-embed.test.ts`

---

## Spec coverage checklist

| Spec requirement                             | Task       |
| -------------------------------------------- | ---------- |
| Bearer auth reuse                            | 5          |
| WOS 403 gate                                 | 5–6        |
| `GET /v1/heroes`                             | 3, 6       |
| `GET /v1/heroes/:heroKey/stats`              | 1, 2, 4, 6 |
| Scopes all/last/range/both + games + from/to | 1, 4       |
| Full combat + items + avg/sum aggregates     | 2, 4       |
| Top players min 3 / clamp                    | 1, 2       |
| `GET /v1/matches/:matchId/stats`             | 4, 6       |
| Omit players without stats                   | 4          |
| Wrong method → 404                           | 6          |
| Docs + cross-link                            | 7          |
| No Discord embed changes / no new env        | Global     |

## Out of scope (do not implement)

- Player-centric routes
- `/items` meta API
- Public unauthenticated access
- Rollup tables
