# League Season Rollover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff archive an active league and open a successor with continue (identity copy), soft, or hard OpenSkill seeding, moving channel bindings and blocking play on the archived league.

**Architecture:** Add `LeagueStatus` + lineage columns on `League`. Core use-case in `src/services/league/league-rollover.ts` (preview, draft, transaction). `/league rollover` + Confirm/Cancel buttons mirror rank-reset. `resolveLeagueContext` and write paths reject `ARCHIVED` leagues. Short-lived `LeagueRolloverDraft` rows hold rollover params (Discord button `custom_id` limit is 100 chars — successor name does not fit).

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-19-league-rollover-design.md`

## Global Constraints

- Scope: `general` (league lifecycle + OpenSkill seeding; not game-specific)
- English-only user-facing strings and errors; say **ki** / "rank", not "Elo"
- OpenSkill defaults: μ `25.0`, σ `8.333`; soft-reset σ floor `6.0`
- Soft compression range `0.0`–`1.0`, default `0.5`; `retention = 1 - compression`. Reject `compression` unless `resetMode === 'soft'`
- `continue` copies μ, σ, and hero `matchesPlayed` unchanged; do not invent missing global rows
- `continue` is not `soft` with compression `0`
- Block rollover when source has any `PENDING` or `IN_PROGRESS` match
- Archived leagues: no new matches, wc3stats import, rank reset, or config writes
- Permission: `assertCanConfigureBot` (same as `/league create`)
- Confirm/Cancel actor-bound buttons; re-validate on confirm
- ESM imports use `.js` extension; named exports; Prisma singleton from `src/lib/prisma.ts`
- No new production env / SSM keys
- Docs already written: `a6-league-rollover.md`, cheat sheet, public `06-rank-and-boards.md`

## File map

| File                                                            | Role                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| `prisma/schema.prisma`                                          | `LeagueStatus`, league columns, `LeagueRolloverDraft`      |
| `prisma/migrations/…_league_rollover/`                          | Migration SQL                                              |
| `src/services/league/league-rollover.ts`                        | Math, preview, draft, apply transaction                    |
| `src/services/league/league-rollover.test.ts`                   | Unit tests                                                 |
| `src/services/league/league.ts`                                 | `listActiveLeaguesForGuild`, `listArchivedLeaguesForGuild` |
| `src/services/league/league-resolve.ts`                         | Active-only fallback; optional archived reads              |
| `src/services/league/league-interaction.ts`                     | Autocomplete filters; archived error constant              |
| `src/services/league/index.ts`                                  | Re-exports                                                 |
| `src/commands/league/league.ts`                                 | `rollover` subcommand + list sections                      |
| `src/commands/league/league.test.ts`                            | Slash data tests                                           |
| `src/discord/interactions/league-rollover-interactions.ts`      | Confirm/Cancel handler                                     |
| `src/discord/interactions/league-rollover-interactions.test.ts` | Button tests                                               |
| `src/events/interaction-create.ts`                              | Route rollover buttons                                     |
| `src/services/rating/rank-reset.ts`                             | Reject archived league in preview                          |
| `src/services/match/match-service.ts` (or create path)          | Reject archived on lobby create                            |
| `src/commands/config/config.ts`                                 | Reject config writes on archived league                    |

---

### Task 1: Schema — league status + rollover draft

**Files:**

- Modify: `prisma/schema.prisma`
- Create: migration via `npm run db:migrate` (name: `league_rollover`)

**Interfaces:**

- Produces:
  - `enum LeagueStatus { ACTIVE ARCHIVED }`
  - `League.status LeagueStatus @default(ACTIVE)`
  - `League.predecessorLeagueId String?`
  - `League.archivedAt DateTime?`
  - Self-relation `LeagueSuccession`
  - `model LeagueRolloverDraft` (see below)

- [ ] **Step 1: Extend Prisma schema**

Add enum after `LeagueBindingKind`:

```prisma
enum LeagueStatus {
  ACTIVE
  ARCHIVED
}
```

On `League`, after `lobbyChannelId`:

```prisma
  status              LeagueStatus @default(ACTIVE)
  predecessorLeagueId String?
  archivedAt          DateTime?

  predecessor League?  @relation("LeagueSuccession", fields: [predecessorLeagueId], references: [id])
  successors  League[] @relation("LeagueSuccession")
  rolloverDrafts LeagueRolloverDraft[]
```

Add model:

```prisma
model LeagueRolloverDraft {
  id               String   @id @default(cuid())
  sourceLeagueId   String
  successorName    String
  resetMode        String   // "hard" | "soft" | "continue"
  compression      Float?
  actorDiscordId   String
  createdAt        DateTime @default(now())

  sourceLeague League @relation(fields: [sourceLeagueId], references: [id], onDelete: Cascade)

  @@index([sourceLeagueId, actorDiscordId, createdAt])
}
```

- [ ] **Step 2: Create migration**

Run:

```bash
npm run db:migrate -- --name league_rollover
```

If DB unavailable, hand-write `prisma/migrations/20260819120000_league_rollover/migration.sql`:

```sql
CREATE TYPE "LeagueStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

ALTER TABLE "League" ADD COLUMN "status" "LeagueStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "League" ADD COLUMN "predecessorLeagueId" TEXT;
ALTER TABLE "League" ADD COLUMN "archivedAt" TIMESTAMP(3);

ALTER TABLE "League" ADD CONSTRAINT "League_predecessorLeagueId_fkey"
  FOREIGN KEY ("predecessorLeagueId") REFERENCES "League"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "LeagueRolloverDraft" (
  "id" TEXT NOT NULL,
  "sourceLeagueId" TEXT NOT NULL,
  "successorName" TEXT NOT NULL,
  "resetMode" TEXT NOT NULL,
  "compression" DOUBLE PRECISION,
  "actorDiscordId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeagueRolloverDraft_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "LeagueRolloverDraft" ADD CONSTRAINT "LeagueRolloverDraft_sourceLeagueId_fkey"
  FOREIGN KEY ("sourceLeagueId") REFERENCES "League"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "LeagueRolloverDraft_sourceLeagueId_actorDiscordId_createdAt_idx"
  ON "LeagueRolloverDraft"("sourceLeagueId", "actorDiscordId", "createdAt");
```

Then:

```bash
npm run db:generate
```

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(league): add status, lineage, and rollover draft schema"
```

---

### Task 2: Soft-reset math + rollover use-case (pure + DB)

**Files:**

- Create: `src/services/league/league-rollover.ts`
- Create: `src/services/league/league-rollover.test.ts`
- Modify: `src/services/league/index.ts`

**Interfaces:**

- Produces:

```typescript
export class LeagueRolloverError extends Error {}

export const ROLLOVER_COMPRESSION_MIN = 0;
export const ROLLOVER_COMPRESSION_MAX = 1;
export const ROLLOVER_COMPRESSION_DEFAULT = 0.5;
export const ROLLOVER_DRAFT_TTL_MS = 15 * 60 * 1000;

export type LeagueResetMode = 'hard' | 'soft' | 'continue';

export type SoftResetEntity = { mu: number; sigma: number };
export type SoftResetHeroEntity = SoftResetEntity & { heroId: number; matchesPlayed: number };

export function assertRolloverCompression(value: number): number;
export function compressMu(oldMu: number, meanMu: number, compression: number): number;
export function compressSigma(oldSigma: number): number;
export function seedSoftGlobalRatings(
  rows: Array<{ playerId: string; mu: number; sigma: number }>,
  compression: number,
): Array<{ playerId: string; mu: number; sigma: number }>;
export function seedSoftHeroRatings(
  rows: Array<{
    playerId: string;
    heroId: number;
    mu: number;
    sigma: number;
    matchesPlayed: number;
  }>,
  compression: number,
): Array<{ playerId: string; heroId: number; mu: number; sigma: number; matchesPlayed: number }>;
export function seedContinueGlobalRatings(
  rows: Array<{ playerId: string; mu: number; sigma: number }>,
): Array<{ playerId: string; mu: number; sigma: number }>;
export function seedContinueHeroRatings(
  rows: Array<{
    playerId: string;
    heroId: number;
    mu: number;
    sigma: number;
    matchesPlayed: number;
  }>,
): Array<{ playerId: string; heroId: number; mu: number; sigma: number; matchesPlayed: number }>;

export type PreviewLeagueRolloverInput = {
  guildId: string;
  sourceLeagueId: string;
  successorName: string;
  resetMode: LeagueResetMode;
  compression?: number;
  actorDiscordId: string;
};

export type LeagueRolloverPreview = {
  draftId: string;
  sourceLeagueId: string;
  sourceLeagueName: string;
  successorName: string;
  resetMode: LeagueResetMode;
  compression: number | null;
  playerCount: number;
  bindingCount: number;
};

export type ApplyLeagueRolloverInput = {
  draftId: string;
  actorDiscordId: string;
  expectedSourceLeagueId?: string;
};

export type LeagueRolloverResult = {
  archivedLeagueId: string;
  archivedLeagueName: string;
  successorLeagueId: string;
  successorLeagueName: string;
  resetMode: LeagueResetMode;
  compression: number | null;
  playersSeeded: number;
  bindingsMoved: number;
};

export function buildRolloverConfirmCustomId(draftId: string, actorDiscordId: string): string;
export function buildRolloverCancelCustomId(draftId: string, actorDiscordId: string): string;
export function parseRolloverButtonCustomId(
  customId: string,
): { action: 'confirm' | 'cancel'; draftId: string; actorDiscordId: string } | null;

export async function previewLeagueRollover(
  input: PreviewLeagueRolloverInput,
): Promise<LeagueRolloverPreview>;
export async function applyLeagueRollover(
  input: ApplyLeagueRolloverInput,
): Promise<LeagueRolloverResult>;
export async function cancelLeagueRolloverDraft(
  draftId: string,
  actorDiscordId: string,
): Promise<void>;
```

- [ ] **Step 1: Write failing tests for math**

```typescript
import { describe, expect, it } from 'vitest';
import {
  compressMu,
  compressSigma,
  seedSoftGlobalRatings,
  seedSoftHeroRatings,
  seedContinueGlobalRatings,
  seedContinueHeroRatings,
  assertRolloverCompression,
} from './league-rollover.js';

describe('compressMu', () => {
  it('pulls halfway toward mean at compression 0.5', () => {
    expect(compressMu(30, 20, 0.5)).toBe(25);
  });

  it('returns mean at compression 1', () => {
    expect(compressMu(40, 25, 1)).toBe(25);
  });

  it('returns old mu at compression 0', () => {
    expect(compressMu(40, 25, 0)).toBe(40);
  });
});

describe('compressSigma', () => {
  it('raises low veteran sigma to floor 6', () => {
    expect(compressSigma(2.5)).toBe(6);
  });

  it('caps at default 8.333', () => {
    expect(compressSigma(8.333)).toBe(8.333);
  });
});

describe('seedSoftGlobalRatings', () => {
  it('compresses each player toward league mean independently', () => {
    const out = seedSoftGlobalRatings(
      [
        { playerId: 'a', mu: 30, sigma: 3 },
        { playerId: 'b', mu: 20, sigma: 3 },
      ],
      0.5,
    );
    expect(out).toEqual([
      { playerId: 'a', mu: 25, sigma: 6 },
      { playerId: 'b', mu: 22.5, sigma: 6 },
    ]);
  });
});

describe('seedSoftHeroRatings', () => {
  it('uses per-hero means and zeroes matchesPlayed', () => {
    const out = seedSoftHeroRatings(
      [
        { playerId: 'a', heroId: 1, mu: 30, sigma: 3, matchesPlayed: 12 },
        { playerId: 'b', heroId: 1, mu: 20, sigma: 3, matchesPlayed: 8 },
      ],
      0.5,
    );
    expect(out[0]).toMatchObject({ playerId: 'a', heroId: 1, mu: 25, matchesPlayed: 0 });
    expect(out[1]).toMatchObject({ playerId: 'b', heroId: 1, mu: 22.5, matchesPlayed: 0 });
  });
});

describe('assertRolloverCompression', () => {
  it('rejects out of range', () => {
    expect(() => assertRolloverCompression(1.1)).toThrow(/between 0 and 1/);
  });
});

describe('seedContinueGlobalRatings', () => {
  it('copies mu and sigma unchanged', () => {
    const rows = [{ playerId: 'a', mu: 30, sigma: 3 }];
    expect(seedContinueGlobalRatings(rows)).toEqual(rows);
  });
});

describe('seedContinueHeroRatings', () => {
  it('copies mu, sigma, and matchesPlayed unchanged', () => {
    const rows = [{ playerId: 'a', heroId: 1, mu: 30, sigma: 3, matchesPlayed: 12 }];
    expect(seedContinueHeroRatings(rows)).toEqual(rows);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm test -- src/services/league/league-rollover.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement math + constants**

```typescript
const DEFAULT_MU = 25;
const DEFAULT_SIGMA = 8.333;
const SIGMA_FLOOR = 6;

export function compressMu(oldMu: number, meanMu: number, compression: number): number {
  const retention = 1 - compression;
  return meanMu + (oldMu - meanMu) * retention;
}

export function compressSigma(oldSigma: number): number {
  return Math.min(DEFAULT_SIGMA, Math.max(SIGMA_FLOOR, oldSigma));
}

function meanOf(values: number[], fallback = DEFAULT_MU): number {
  if (values.length === 0) return fallback;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function seedSoftGlobalRatings(
  rows: Array<{ playerId: string; mu: number; sigma: number }>,
  compression: number,
): Array<{ playerId: string; mu: number; sigma: number }> {
  const meanMu = meanOf(rows.map((r) => r.mu));
  return rows.map((row) => ({
    playerId: row.playerId,
    mu: compressMu(row.mu, meanMu, compression),
    sigma: compressSigma(row.sigma),
  }));
}

export function seedSoftHeroRatings(
  rows: Array<{
    playerId: string;
    heroId: number;
    mu: number;
    sigma: number;
    matchesPlayed: number;
  }>,
  compression: number,
): Array<{ playerId: string; heroId: number; mu: number; sigma: number; matchesPlayed: number }> {
  const byHero = new Map<number, number[]>();
  for (const row of rows) {
    const list = byHero.get(row.heroId) ?? [];
    list.push(row.mu);
    byHero.set(row.heroId, list);
  }
  return rows.map((row) => {
    const meanHeroMu = meanOf(byHero.get(row.heroId) ?? []);
    return {
      playerId: row.playerId,
      heroId: row.heroId,
      mu: compressMu(row.mu, meanHeroMu, compression),
      sigma: compressSigma(row.sigma),
      matchesPlayed: 0,
    };
  });
}

export function seedContinueGlobalRatings(
  rows: Array<{ playerId: string; mu: number; sigma: number }>,
): Array<{ playerId: string; mu: number; sigma: number }> {
  return rows.map((row) => ({ playerId: row.playerId, mu: row.mu, sigma: row.sigma }));
}

export function seedContinueHeroRatings(
  rows: Array<{
    playerId: string;
    heroId: number;
    mu: number;
    sigma: number;
    matchesPlayed: number;
  }>,
): Array<{ playerId: string; heroId: number; mu: number; sigma: number; matchesPlayed: number }> {
  return rows.map((row) => ({
    playerId: row.playerId,
    heroId: row.heroId,
    mu: row.mu,
    sigma: row.sigma,
    matchesPlayed: row.matchesPlayed,
  }));
}
```

- [ ] **Step 4: Write failing preview/apply tests (prisma mock)**

Use `vi.mock('../../lib/prisma.js')` hoisted fns like `league-resolve.test.ts`. Include `$transaction` that invokes the callback with a `tx` object of the same mocks.

```typescript
it('rejects compression unless reset is soft', async () => {
  await expect(
    previewLeagueRollover({
      guildId: 'g1',
      sourceLeagueId: 'src',
      successorName: 'Season 1.5',
      resetMode: 'continue',
      compression: 0.5,
      actorDiscordId: 'actor',
    }),
  ).rejects.toThrow(/Compression is only used with reset:soft/);

  await expect(
    previewLeagueRollover({
      guildId: 'g1',
      sourceLeagueId: 'src',
      successorName: 'Fresh',
      resetMode: 'hard',
      compression: 0.5,
      actorDiscordId: 'actor',
    }),
  ).rejects.toThrow(/Compression is only used with reset:soft/);
});

it('continue copies mu, sigma, matchesPlayed onto a new leagueId', async () => {
  // source ACTIVE; no PENDING/IN_PROGRESS; one PlayerRating + one PlayerHeroRating
  const result = await applyLeagueRollover({ draftId: 'draft-1', actorDiscordId: 'actor' });
  expect(result.resetMode).toBe('continue');
  expect(result.compression).toBeNull();
  expect(playerRatingCreateMany).toHaveBeenCalledWith({
    data: [{ leagueId: result.successorLeagueId, playerId: 'p1', mu: 30, sigma: 3 }],
  });
  expect(playerHeroRatingCreateMany).toHaveBeenCalledWith({
    data: [
      {
        leagueId: result.successorLeagueId,
        playerId: 'p1',
        heroId: 1,
        mu: 28,
        sigma: 4,
        matchesPlayed: 12,
      },
    ],
  });
  expect(leagueUpdate).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: 'src' },
      data: expect.objectContaining({ status: 'ARCHIVED' }),
    }),
  );
  expect(playerRatingUpdate).not.toHaveBeenCalled();
});

it('continue does not invent a global row for a hero-only player', async () => {
  // source has PlayerHeroRating for p2 only (no PlayerRating)
  await applyLeagueRollover({ draftId: 'draft-1', actorDiscordId: 'actor' });
  const globals = playerRatingCreateMany.mock.calls[0]?.[0]?.data ?? [];
  expect(globals.some((row: { playerId: string }) => row.playerId === 'p2')).toBe(false);
});

it('rejects archived source and active matches', async () => {
  leagueFindUnique.mockResolvedValue({ id: 'src', guildId: 'g1', status: 'ARCHIVED', name: 'S1' });
  await expect(
    previewLeagueRollover({
      guildId: 'g1',
      sourceLeagueId: 'src',
      successorName: 'S2',
      resetMode: 'soft',
      actorDiscordId: 'actor',
    }),
  ).rejects.toThrow(/archived and cannot be rolled over/);
});
```

Also cover: hard reset defaults only (no hero createMany); soft reset `matchesPlayed: 0`; bindings `updateMany` source → successor; empty league continue seeds 0 players and still archives.

- [ ] **Step 5: Implement `previewLeagueRollover`**

Checks:

1. Source exists, `guildId` matches, `status === ACTIVE`
2. `successorName.trim()` non-empty
3. `resetMode === 'soft'` → `assertRolloverCompression(compression ?? 0.5)`. `continue`/`hard` + provided compression → throw `Compression is only used with reset:soft.`
4. `match.count` where `leagueId` + `PENDING|IN_PROGRESS` → throw with ids
5. Count ratings + bindings for preview message
6. Delete expired drafts for same actor/source older than `ROLLOVER_DRAFT_TTL_MS`
7. `create` `LeagueRolloverDraft`, return preview

- [ ] **Step 6: Implement `applyLeagueRollover` transaction**

1. Load draft; verify `actorDiscordId`; verify source still ACTIVE; re-check active matches
2. `create` successor with copied config fields (see spec list); `predecessorLeagueId: source.id`
3. Load source ratings + hero ratings
4. Hard: `createMany` global defaults for each playerId
5. Soft: `createMany` seeded globals + heroes
6. Continue: `createMany` identity-copied globals + heroes (no invented globals)
7. Copy `LeagueWc3statsSlotMap` via `createMany`
8. `updateMany` bindings `leagueId: source → successor`
9. `update` source `{ status: ARCHIVED, archivedAt: now, leaderboardMessageId: null }`
10. `delete` draft
11. Return result

Custom id format (fits 100 chars):

```text
lv:c:{draftId}:{actorDiscordId}
lv:x:{draftId}:{actorDiscordId}
```

Prefix `lv` (league rollover), not `lr`, to avoid collision with leaderboard handlers.

- [ ] **Step 7: Run tests — expect PASS**

```bash
npm test -- src/services/league/league-rollover.test.ts
```

- [ ] **Step 8: Export from `src/services/league/index.ts`**

- [ ] **Step 9: Commit**

```bash
git add src/services/league/league-rollover.ts src/services/league/league-rollover.test.ts src/services/league/index.ts
git commit -m "feat(league): add rollover preview, apply, and continue/soft/hard seeding"
```

---

### Task 3: League resolve + list helpers + archived guards

**Files:**

- Modify: `src/services/league/league.ts`
- Modify: `src/services/league/league-resolve.ts`
- Modify: `src/services/league/league-resolve.test.ts`
- Modify: `src/services/league/league-interaction.ts`

**Interfaces:**

- Produces:

```typescript
export const LEAGUE_ARCHIVED_MESSAGE =
  'That league is archived. Start a new season or pick an active league.';

export async function listActiveLeaguesForGuild(guildId: string): Promise<League[]>;
export async function listArchivedLeaguesForGuild(guildId: string): Promise<League[]>;

export function isLeagueWritable(league: Pick<League, 'status'>): boolean;

export async function autocompleteActiveGuildLeagues(
  guildId: string,
  query: string,
): Promise<Array<{ name: string; value: string }>>;
export async function autocompleteAllGuildLeagues(
  guildId: string,
  query: string,
): Promise<Array<{ name: string; value: string }>>;
```

- [ ] **Step 1: Write failing resolve test**

In `league-resolve.test.ts`, add:

```typescript
it('single-league fallback ignores archived leagues', async () => {
  // guild has one ARCHIVED league only → no_leagues
});

it('explicit archived league option still resolves for reads', async () => {
  // leagueIdOption pointing at ARCHIVED → ok: true
});
```

- [ ] **Step 2: Update `resolveLeagueContext`**

- Step 1 explicit option: unchanged (allow archived when explicitly chosen)
- Step 4 fallback: `findMany({ where: { guildId, status: 'ACTIVE' } })`

- [ ] **Step 3: Add list helpers in `league.ts`**

```typescript
export async function listActiveLeaguesForGuild(guildId: string): Promise<League[]> {
  return prisma.league.findMany({
    where: { guildId, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  });
}

export async function listArchivedLeaguesForGuild(guildId: string): Promise<League[]> {
  return prisma.league.findMany({
    where: { guildId, status: 'ARCHIVED' },
    orderBy: { archivedAt: 'desc' },
  });
}

export function isLeagueWritable(league: Pick<League, 'status'>): boolean {
  return league.status === 'ACTIVE';
}
```

Keep `listLeaguesForGuild` as all leagues (or delegate to active+archived) for backward compat — update callers intentionally in later tasks.

- [ ] **Step 4: Add autocomplete helpers**

`autocompleteActiveGuildLeagues` — `where: { guildId, status: 'ACTIVE' }`.

`autocompleteAllGuildLeagues` — all leagues; archived display names prefixed `(archived) ` then truncated to 100 chars.

Point `respondLeagueAutocomplete` at `autocompleteActiveGuildLeagues` so play/config stay active-only as soon as `status` exists. History commands opt into archived in Task 7.

- [ ] **Step 5: Run tests**

```bash
npm test -- src/services/league/league-resolve.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/services/league/league.ts src/services/league/league-resolve.ts src/services/league/league-resolve.test.ts src/services/league/league-interaction.ts src/services/league/index.ts
git commit -m "feat(league): resolve active leagues only; add archived helpers"
```

---

### Task 4: Block writes on archived leagues

**Files:**

- Modify: `src/services/rating/rank-reset.ts` (`previewRankReset`, after `prisma.league.findUnique`)
- Modify: `src/services/match/match-service.ts` (`createPendingMatch`, before `loadMatchProfile`)
- Modify: `src/services/lobby/register-lobby-source.ts` (`assertLeagueAllowsWc3stats` and `assertLeagueAllowsWc3statsImport`)
- Modify: `src/commands/config/config.ts` (after `resolveLeagueIdFromInteraction` on mutating subcommands)
- Test: `src/services/rating/rank-reset.test.ts`
- Test: `src/services/match/match-service.test.ts` (or the existing createPendingMatch test file)

**Interfaces:**

- Consumes: `isLeagueWritable`, `LEAGUE_ARCHIVED_MESSAGE` from Task 3

- [ ] **Step 1: Rank reset guard**

In `previewRankReset`, after loading `league`:

```typescript
if (!isLeagueWritable(league)) {
  throw new RankResetServiceError(LEAGUE_ARCHIVED_MESSAGE);
}
```

Test: archived league → throws `LEAGUE_ARCHIVED_MESSAGE`.

- [ ] **Step 2: Match create guard**

At the start of `createPendingMatch`:

```typescript
const league = await prisma.league.findUnique({ where: { id: input.leagueId } });
if (!league || !isLeagueWritable(league)) {
  throw new MatchServiceError(LEAGUE_ARCHIVED_MESSAGE);
}
```

Test: `createPendingMatch` with archived `leagueId` throws `MatchServiceError` with that message.

- [ ] **Step 3: Config writes**

In `src/commands/config/config.ts`, after a mutating path resolves `leagueId`, load the league (or reuse resolve result) and if `!isLeagueWritable` reply ephemeral with `LEAGUE_ARCHIVED_MESSAGE` (same pattern as other config errors). Cover `/config set` not `/config view`.

- [ ] **Step 4: wc3stats import/config**

In `assertLeagueAllowsWc3stats` and `assertLeagueAllowsWc3statsImport` (`src/services/lobby/register-lobby-source.ts`), after resolving the league/profile, load `League.status` and throw `MatchServiceError(LEAGUE_ARCHIVED_MESSAGE)` when archived. That covers `/register_lobby` wc3stats, `createMatchFromWc3statsLobby`, slot-map writes, and `/config` wc3stats sets that already call these helpers.

- [ ] **Step 5: Run targeted tests**

```bash
npm test -- src/services/rating/rank-reset.test.ts src/services/match/ src/services/lobby/register-lobby-source.ts
```

Expected: PASS (add a test file for `register-lobby-source` if none exists).

- [ ] **Step 6: Commit**

```bash
git add src/services/rating/rank-reset.ts src/services/match/match-service.ts src/services/lobby/register-lobby-source.ts src/commands/config/config.ts
git commit -m "fix(league): reject write operations on archived leagues"
```

---

### Task 5: `/league rollover` command + list sections

**Files:**

- Modify: `src/commands/league/league.ts`
- Modify: `src/commands/league/league.test.ts`

**Interfaces:**

- Consumes: `previewLeagueRollover`, `buildRolloverConfirmComponents` (from interactions file — or build inline and extract in Task 6)

- [ ] **Step 1: Extend slash command data test**

```typescript
expect(names).toEqual(['create', 'list', 'bind', 'unbind', 'rollover']);
```

- [ ] **Step 2: Add subcommand**

```typescript
.addSubcommand((subcommand) =>
  subcommand
    .setName('rollover')
    .setDescription('Archive a league and open a successor season')
    .addStringOption((option) =>
      option.setName('name').setDescription('Display name for the new league').setRequired(true).setMaxLength(100),
    )
    .addStringOption((option) =>
      option
        .setName('reset')
        .setDescription('Rating seed mode for the new league')
        .setRequired(true)
        .addChoices(
          { name: 'Continue — copy ki unchanged', value: 'continue' },
          { name: 'Soft — compress toward average', value: 'soft' },
          { name: 'Hard — everyone back to ~1000 ki', value: 'hard' },
        ),
    )
    .addNumberOption((option) =>
      option
        .setName('compression')
        .setDescription('Soft reset pull toward average (0–1, default 0.5)')
        .setMinValue(0)
        .setMaxValue(1)
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('league')
        .setDescription('League to archive (required when multiple active leagues)')
        .setRequired(false)
        .setAutocomplete(true),
    ),
)
```

- [ ] **Step 3: Implement execute branch**

1. Resolve source league via `resolveLeagueIdFromInteraction` with active-only autocomplete helper for rollover
2. If multiple active leagues and no option → ephemeral error
3. Call `previewLeagueRollover`
4. Reply ephemeral with summary + Confirm/Cancel components

Preview message template:

```text
Archive **{source}** and create **{successor}**?
• Reset: continue
• Ratings copied unchanged (old league frozen)
• Players seeded: N
• Bindings moved: M

This cannot be undone.
```

For `soft` / `hard`, same shape with `• Reset: soft (compression 0.5)` or `• Reset: hard` and **no** "copied unchanged" line.

- [ ] **Step 4: Update `list` subcommand**

```typescript
const active = await listActiveLeaguesForGuild(guildId);
const archived = await listArchivedLeaguesForGuild(guildId);
// format two sections per spec
```

- [ ] **Step 5: Update rollover autocomplete**

In `autocomplete`, when subcommand is `rollover`, use `autocompleteActiveGuildLeagues`.

- [ ] **Step 6: Run tests**

```bash
npm test -- src/commands/league/league.test.ts
```

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(league): add rollover subcommand and archived list sections"
```

---

### Task 6: Confirm/Cancel button handler

**Files:**

- Create: `src/discord/interactions/league-rollover-interactions.ts`
- Create: `src/discord/interactions/league-rollover-interactions.test.ts`
- Modify: `src/events/interaction-create.ts`

**Interfaces:**

- Produces:

```typescript
export function buildRolloverConfirmComponents(input: {
  draftId: string;
  actorDiscordId: string;
}): ActionRowBuilder<ButtonBuilder>[];
export async function handleLeagueRolloverInteraction(interaction: Interaction): Promise<boolean>;
```

- [ ] **Step 1: Write failing button tests**

```typescript
import type { Interaction } from 'discord.js';
import { ButtonStyle, MessageFlags } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { applyLeagueRollover, cancelLeagueRolloverDraft, refreshLeagueLeaderboard } = vi.hoisted(
  () => ({
    applyLeagueRollover: vi.fn(),
    cancelLeagueRolloverDraft: vi.fn(),
    refreshLeagueLeaderboard: vi.fn(),
  }),
);

vi.mock('../../services/league/index.js', () => ({
  applyLeagueRollover,
  cancelLeagueRolloverDraft,
  buildRolloverConfirmCustomId: (draftId: string, actorDiscordId: string) =>
    `lv:c:${draftId}:${actorDiscordId}`,
  buildRolloverCancelCustomId: (draftId: string, actorDiscordId: string) =>
    `lv:x:${draftId}:${actorDiscordId}`,
  parseRolloverButtonCustomId: (customId: string) => {
    const [prefix, action, draftId, actorDiscordId, extra] = customId.split(':');
    if (
      prefix !== 'lv' ||
      (action !== 'c' && action !== 'x') ||
      !draftId ||
      !actorDiscordId ||
      extra
    ) {
      return null;
    }
    return { action: action === 'c' ? 'confirm' : 'cancel', draftId, actorDiscordId };
  },
}));

vi.mock('../../services/leaderboard/index.js', () => ({ refreshLeagueLeaderboard }));

function buttonInteraction(customId: string, overrides: Record<string, unknown> = {}): Interaction {
  return {
    isButton: () => true,
    customId,
    user: { id: 'actor-1' },
    guildId: 'guild-1',
    reply: vi.fn(),
    update: vi.fn(),
    deferUpdate: vi.fn(),
    editReply: vi.fn(),
    client: { user: { id: 'bot-1' } },
    ...overrides,
  } as unknown as Interaction;
}

describe('buildRolloverConfirmComponents', () => {
  it('builds actor-bound confirm and cancel buttons', () => {
    const [row] = buildRolloverConfirmComponents({ draftId: 'draft-1', actorDiscordId: 'actor-1' });
    expect(row?.toJSON()).toEqual({
      type: 1,
      components: [
        {
          type: 2,
          custom_id: 'lv:c:draft-1:actor-1',
          label: 'Confirm rollover',
          style: ButtonStyle.Danger,
        },
        {
          type: 2,
          custom_id: 'lv:x:draft-1:actor-1',
          label: 'Cancel',
          style: ButtonStyle.Secondary,
        },
      ],
    });
  });
});

describe('handleLeagueRolloverInteraction', () => {
  it('returns false for non-lv custom ids', async () => {
    expect(await handleLeagueRolloverInteraction(buttonInteraction('rr:c:x:y:z'))).toBe(false);
  });

  it('rejects a different actor', async () => {
    const interaction = buttonInteraction('lv:c:draft-1:actor-1', { user: { id: 'other' } });
    expect(await handleLeagueRolloverInteraction(interaction)).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Only the person who ran /league rollover can use these buttons.',
      flags: MessageFlags.Ephemeral,
    });
    expect(applyLeagueRollover).not.toHaveBeenCalled();
  });

  it('cancels the draft', async () => {
    const interaction = buttonInteraction('lv:x:draft-1:actor-1');
    await handleLeagueRolloverInteraction(interaction);
    expect(cancelLeagueRolloverDraft).toHaveBeenCalledWith('draft-1', 'actor-1');
    expect(interaction.update).toHaveBeenCalledWith({
      content: 'Rollover cancelled.',
      components: [],
    });
  });

  it('applies rollover and refreshes the successor leaderboard', async () => {
    applyLeagueRollover.mockResolvedValue({
      archivedLeagueId: 'src',
      archivedLeagueName: 'Season 1',
      successorLeagueId: 'dst',
      successorLeagueName: 'Season 1.5',
      resetMode: 'continue',
      compression: null,
      playersSeeded: 4,
      bindingsMoved: 2,
    });
    const interaction = buttonInteraction('lv:c:draft-1:actor-1');
    await handleLeagueRolloverInteraction(interaction);
    expect(applyLeagueRollover).toHaveBeenCalledWith({
      draftId: 'draft-1',
      actorDiscordId: 'actor-1',
    });
    expect(refreshLeagueLeaderboard).toHaveBeenCalledWith(interaction.client, 'dst');
  });
});
```

- [ ] **Step 2: Implement handler**

On confirm:

1. `applyLeagueRollover({ draftId, actorDiscordId, expectedSourceLeagueId })`
2. Optional: `refreshLeagueLeaderboard(client, successorLeagueId)` if channel configured
3. Success ephemeral with archived + successor ids

On cancel: `cancelLeagueRolloverDraft`

- [ ] **Step 3: Wire in `interaction-create.ts`**

Insert before rank-reset handler:

```typescript
import { handleLeagueRolloverInteraction } from '../discord/interactions/league-rollover-interactions.js';

if (await handleLeagueRolloverInteraction(interaction)) {
  return;
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- src/discord/interactions/league-rollover-interactions.test.ts
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(league): add rollover confirm/cancel interactions"
```

---

### Task 7: History command autocomplete (archived leagues)

**Files:**

- Modify: `src/services/league/league-interaction.ts` (`respondLeagueAutocomplete`)
- Modify: `src/commands/match/match.ts`
- Modify: `src/commands/player/leaderboard.ts`
- Modify: `src/commands/league/league.ts` (rollover autocomplete stays active-only)

**Interfaces:**

- Consumes: `autocompleteActiveGuildLeagues`, `autocompleteAllGuildLeagues` from Task 3

- [ ] **Step 1: Add includeArchived flag to autocomplete responder**

```typescript
export async function respondLeagueAutocomplete(
  interaction: AutocompleteInteraction,
  options?: { includeArchived?: boolean },
): Promise<boolean> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'league') {
    return false;
  }
  if (!interaction.guildId) {
    await interaction.respond([]);
    return true;
  }
  const choices = options?.includeArchived
    ? await autocompleteAllGuildLeagues(interaction.guildId, focused.value)
    : await autocompleteActiveGuildLeagues(interaction.guildId, focused.value);
  await interaction.respond(choices);
  return true;
}
```

`autocompleteAllGuildLeagues` prefixes archived names with `(archived) ` (max 100 chars). Default `includeArchived: false` so play/config/rollover stay ACTIVE-only without call-site changes.

- [ ] **Step 2: History commands opt in**

In `src/commands/match/match.ts` and `src/commands/player/leaderboard.ts`:

```typescript
await respondLeagueAutocomplete(interaction, { includeArchived: true });
```

Keep `/register_lobby`, `/config`, `/rank_reset`, `/league rollover` on the default (active only).

- [ ] **Step 3: Run tests**

```bash
npm test -- src/commands/match/ src/commands/player/leaderboard.ts src/commands/league/league.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/league/league-interaction.ts src/commands/match/match.ts src/commands/player/leaderboard.ts
git commit -m "feat(league): include archived leagues in history autocomplete"
```

---

### Task 8: Full test pass + spec status

**Files:**

- Modify: `docs/superpowers/specs/2026-08-19-league-rollover-design.md` (status → Implemented when done)

- [ ] **Step 1: Run full suite**

```bash
npm test
npm run build
```

- [ ] **Step 2: Fix any regressions**

- [ ] **Step 3: Final commit if needed**

```bash
git commit -m "test(league): fix rollover integration regressions"
```

---

## Spec coverage checklist

| Spec requirement                                          | Task                            |
| --------------------------------------------------------- | ------------------------------- |
| `LeagueStatus` + lineage columns                          | Task 1                          |
| Block active matches                                      | Task 2                          |
| Continue identity copy (μ, σ, `matchesPlayed`)            | Task 2                          |
| Continue does not invent missing globals                  | Task 2                          |
| Compression rejected for continue/hard                    | Task 2                          |
| Hard reset seeding                                        | Task 2                          |
| Soft reset global + hero math                             | Task 2                          |
| Config copy + slot maps + bindings                        | Task 2                          |
| Archive source league                                     | Task 2                          |
| Continue preview copy (unchanged ki, freeze)              | Task 5                          |
| `/league rollover` options including `continue`           | Task 5                          |
| Confirm/Cancel buttons                                    | Task 6                          |
| Refresh successor leaderboard after apply                 | Task 6                          |
| `/league list` sections                                   | Task 5                          |
| Archived write guards                                     | Task 4                          |
| Active-only play autocomplete                             | Task 3, 5                       |
| History includes archived (`/match list`, `/leaderboard`) | Task 7                          |
| Staff/player docs (continue recipe)                       | Already committed in spec phase |
| Error messages English                                    | Tasks 2, 4, 5, 6                |

## Self-review

- Continue, soft, and hard each have tests and command choices
- Compression rejected unless `resetMode === 'soft'`
- Button prefix `lv:` documented consistently (`LeagueRolloverDraft` holds successor name)
- Types align across tasks (`LeagueResetMode` includes `'continue'`; `LeagueRolloverPreview.draftId` → button → `applyLeagueRollover`)
- History autocomplete files are `src/commands/match/match.ts` and `src/commands/player/leaderboard.ts`
- Docs pre-written; Task 8 only updates spec status after implementation
