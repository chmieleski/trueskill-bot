# League Season Rollover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff archive an active league and open a successor with hard or soft OpenSkill seeding, moving channel bindings and blocking play on the archived league.

**Architecture:** Add `LeagueStatus` + lineage columns on `League`. Core use-case in `src/services/league/league-rollover.ts` (preview, draft, transaction). `/league rollover` + Confirm/Cancel buttons mirror rank-reset. `resolveLeagueContext` and write paths reject `ARCHIVED` leagues. Short-lived `LeagueRolloverDraft` rows hold rollover params (Discord button `custom_id` limit is 100 chars — successor name does not fit).

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-19-league-rollover-design.md`

## Global Constraints

- Scope: `general` (league lifecycle + OpenSkill seeding; not game-specific)
- English-only user-facing strings and errors; say **ki** / "rank", not "Elo"
- OpenSkill defaults: μ `25.0`, σ `8.333`; soft-reset σ floor `6.0`
- Soft compression range `0.0`–`1.0`, default `0.5`; `retention = 1 - compression`
- Block rollover when source has any `PENDING` or `IN_PROGRESS` match
- Archived leagues: no new matches, wc3stats import, rank reset, or config writes
- Permission: `assertCanConfigureBot` (same as `/league create`)
- Confirm/Cancel actor-bound buttons; re-validate on confirm
- ESM imports use `.js` extension; named exports; Prisma singleton from `src/lib/prisma.ts`
- No new production env / SSM keys
- Docs already written: `a6-league-rollover.md`, cheat sheet, public `06-rank-and-boards.md`

## File map

| File | Role |
|------|------|
| `prisma/schema.prisma` | `LeagueStatus`, league columns, `LeagueRolloverDraft` |
| `prisma/migrations/…_league_rollover/` | Migration SQL |
| `src/services/league/league-rollover.ts` | Math, preview, draft, apply transaction |
| `src/services/league/league-rollover.test.ts` | Unit tests |
| `src/services/league/league.ts` | `listActiveLeaguesForGuild`, `listArchivedLeaguesForGuild` |
| `src/services/league/league-resolve.ts` | Active-only fallback; optional archived reads |
| `src/services/league/league-interaction.ts` | Autocomplete filters; archived error constant |
| `src/services/league/index.ts` | Re-exports |
| `src/commands/league/league.ts` | `rollover` subcommand + list sections |
| `src/commands/league/league.test.ts` | Slash data tests |
| `src/discord/interactions/league-rollover-interactions.ts` | Confirm/Cancel handler |
| `src/discord/interactions/league-rollover-interactions.test.ts` | Button tests |
| `src/events/interaction-create.ts` | Route rollover buttons |
| `src/services/rating/rank-reset.ts` | Reject archived league in preview |
| `src/services/match/match-service.ts` (or create path) | Reject archived on lobby create |
| `src/commands/config/config.ts` | Reject config writes on archived league |

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
  resetMode        String   // "hard" | "soft"
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

export type LeagueResetMode = 'hard' | 'soft';

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
  rows: Array<{ playerId: string; heroId: number; mu: number; sigma: number; matchesPlayed: number }>,
  compression: number,
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
export function parseRolloverButtonCustomId(customId: string): { action: 'confirm' | 'cancel'; draftId: string; actorDiscordId: string } | null;

export async function previewLeagueRollover(input: PreviewLeagueRolloverInput): Promise<LeagueRolloverPreview>;
export async function applyLeagueRollover(input: ApplyLeagueRolloverInput): Promise<LeagueRolloverResult>;
export async function cancelLeagueRolloverDraft(draftId: string, actorDiscordId: string): Promise<void>;
```

- [ ] **Step 1: Write failing tests for math**

```typescript
import { describe, expect, it } from 'vitest';
import {
  compressMu,
  compressSigma,
  seedSoftGlobalRatings,
  seedSoftHeroRatings,
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
  rows: Array<{ playerId: string; heroId: number; mu: number; sigma: number; matchesPlayed: number }>,
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
```

- [ ] **Step 4: Implement preview/apply with mocked prisma tests**

Add vitest mocks for:
- archived source rejected
- active match block
- hard reset creates defaults only
- soft reset copies hero rows
- bindings moved; source archived

Use `vi.mock('../../lib/prisma.js')` pattern from `league-resolve.test.ts`.

- [ ] **Step 5: Implement `previewLeagueRollover`**

Checks:
1. Source exists, `guildId` matches, `status === ACTIVE`
2. `successorName.trim()` non-empty
3. `resetMode === 'soft'` → `assertRolloverCompression(compression ?? 0.5)`
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
6. Copy `LeagueWc3statsSlotMap` via `createMany`
7. `updateMany` bindings `leagueId: source → successor`
8. `update` source `{ status: ARCHIVED, archivedAt: now, leaderboardMessageId: null }`
9. `delete` draft
10. Return result

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
git commit -m "feat(league): add rollover preview, apply, and soft-reset math"
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

export async function autocompleteActiveGuildLeagues(guildId: string, query: string): Promise<Array<{ name: string; value: string }>>;
export async function autocompleteAllGuildLeagues(guildId: string, query: string): Promise<Array<{ name: string; value: string }>>;
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

`autocompleteActiveGuildLeagues` — filter `status: ACTIVE`, suffix archived leagues with nothing (exclude them).

`autocompleteAllGuildLeagues` — include archived with name prefix `(archived) ` for history commands.

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
- Modify: `src/services/rating/rank-reset.ts`
- Modify: `src/services/match/match-service.ts` (lobby create entry — `createMatch` or equivalent)
- Modify: `src/services/league/league-wc3stats.ts` or wc3stats import gate
- Modify: `src/commands/config/config.ts` (league resolve path)

**Interfaces:**
- Consumes: `isLeagueWritable`, `LEAGUE_ARCHIVED_MESSAGE`

- [ ] **Step 1: Rank reset — after loading league**

```typescript
if (league.status === 'ARCHIVED') {
  throw new RankResetServiceError(LEAGUE_ARCHIVED_MESSAGE);
}
```

- [ ] **Step 2: Match create — after league resolve**

When creating/registering lobby, if resolved league not writable → `MatchServiceError(LEAGUE_ARCHIVED_MESSAGE)`.

- [ ] **Step 3: Config set — after league resolve**

Same guard before any mutating config write.

- [ ] **Step 4: wc3stats import path**

Reject import when target league archived.

- [ ] **Step 5: Run targeted tests**

```bash
npm test -- src/services/rating/rank-reset.test.ts src/services/match/
```

Add one test per guard if missing.

- [ ] **Step 6: Commit**

```bash
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
        .addChoices({ name: 'Hard — everyone back to ~1000 ki', value: 'hard' }, { name: 'Soft — compress toward average', value: 'soft' }),
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
• Reset: {hard|soft}{compression line}
• Players seeded: N
• Bindings moved: M

This cannot be undone.
```

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
export function buildRolloverConfirmComponents(input: { draftId: string; actorDiscordId: string }): ActionRowBuilder<ButtonBuilder>[];
export async function handleLeagueRolloverInteraction(interaction: Interaction): Promise<boolean>;
```

- [ ] **Step 1: Write failing button tests**

Mirror `rank-reset-interactions.test.ts`:
- wrong actor → NOT_YOUR_ROLLOVER
- cancel → "Rollover cancelled."
- confirm → calls `applyLeagueRollover`, success message
- malformed custom id → consumed, no throw

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
- Modify: commands that support history reads with `league:` — at minimum:
  - `src/commands/match/match.ts` (match list)
  - `src/commands/leaderboard/leaderboard.ts` (if separate autocomplete)

**Interfaces:**
- Consumes: `autocompleteAllGuildLeagues`

- [ ] **Step 1: Switch match list / leaderboard autocomplete to `autocompleteAllGuildLeagues`**

Keep play commands on active-only.

- [ ] **Step 2: Manual smoke checklist**

- `/match list league:` shows archived names prefixed `(archived)`
- `/register_lobby` against archived binding after rollover → archived error

- [ ] **Step 3: Commit**

```bash
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

| Spec requirement | Task |
|------------------|------|
| `LeagueStatus` + lineage columns | Task 1 |
| Block active matches | Task 2 |
| Hard reset seeding | Task 2 |
| Soft reset global + hero math | Task 2 |
| Config copy + slot maps + bindings | Task 2 |
| Archive source league | Task 2 |
| `/league rollover` options | Task 5 |
| Confirm/Cancel buttons | Task 6 |
| `/league list` sections | Task 5 |
| Archived write guards | Task 4 |
| Active-only play autocomplete | Task 3, 5 |
| History includes archived | Task 7 |
| Staff/player docs | Already committed in spec phase |
| Error messages English | Tasks 2, 4, 5, 6 |

## Self-review

- No TBD steps; custom id limit handled via `LeagueRolloverDraft`
- Button prefix `lv:` documented consistently
- Types align across tasks (`LeagueRolloverPreview.draftId` → button → `applyLeagueRollover`)
- Docs pre-written; Task 8 only updates spec status after implementation
