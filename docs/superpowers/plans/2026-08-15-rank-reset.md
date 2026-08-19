# League Rank (ki) Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let linked players fully reset league ki (overall + all heroes) when enabled, with a per-league day cooldown; match mods can force-reset others (bypass cooldown, restart clock); soft-hide via reject when disabled.

**Architecture:** Store `rankResetEnabled` + `rankResetCooldownDays` on `League`. Use `PlayerRankReset` audit rows as the cooldown source of truth. Shared use-case in `src/services/rating/rank-reset.ts` powers `/rank_reset` and Confirm/Cancel buttons. Config via `/config set rank_reset` and `rank_reset_cooldown`.

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-15-rank-reset-design.md`

## Global Constraints

- Scope: `general` (league-scoped OpenSkill; not game-specific)
- English-only user-facing strings and errors; say **ki** / "rank", not "Elo"
- Feature default **off**; cooldown days schema default **30**; config range **1–365** (reject out of range, do not silently clamp)
- Full wipe only: upsert `PlayerRating` to μ `25` / σ `8.333`; delete all `PlayerHeroRating` for `(leagueId, playerId)`
- Soft-hide: keep `/rank_reset` registered; reject when disabled
- Staff = match mod role (`assertHasMatchModRole`); staff override bypasses cooldown but still writes audit
- Confirm/Cancel for all resets; re-validate on confirm
- Block if target is on any PENDING or IN_PROGRESS match in that league
- ESM imports use `.js` extension; named exports
- No new production env / SSM keys

## File map

| File                                                  | Role                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`                                | League columns + `PlayerRankReset` model + relations                                      |
| `prisma/migrations/…_add_rank_reset/`                 | Migration SQL                                                                             |
| `src/services/rating/rank-reset.ts`                   | Error class, cooldown helpers, eligibility, wipe transaction, button customId parse/build |
| `src/services/rating/rank-reset.test.ts`              | Unit tests for use-case                                                                   |
| `src/services/rating/index.ts`                        | Re-export public API                                                                      |
| `src/services/league/league-wc3stats.ts`              | Extend `ResolvedLeagueConfig` + set helpers                                               |
| `src/services/league/index.ts`                        | Re-export setters                                                                         |
| `src/commands/player/rank-reset.ts`                   | `/rank_reset` slash command                                                               |
| `src/discord/interactions/rank-reset-interactions.ts` | Confirm/Cancel buttons                                                                    |
| `src/events/interaction-create.ts`                    | Route rank-reset buttons                                                                  |
| `src/commands/config/config.ts`                       | set/view wiring                                                                           |
| `docs/discord/staff/a1-roles-and-setup.md`            | Staff setup                                                                               |
| `docs/discord/staff/a5-admin-cheat-sheet.md`          | Cheat sheet lines                                                                         |
| `docs/discord/public/06-rank-and-boards.md`           | Public note                                                                               |

---

### Task 1: Schema + league config fields

**Files:**

- Modify: `prisma/schema.prisma`
- Create: migration via `npx prisma migrate dev --name add_rank_reset` (or hand-write SQL under `prisma/migrations/` if migrate can't reach DB)
- Modify: `src/services/league/league-wc3stats.ts`
- Modify: `src/services/league/index.ts`

**Interfaces:**

- Produces (schema):
  - `League.rankResetEnabled Boolean @default(false)`
  - `League.rankResetCooldownDays Int @default(30)`
  - `model PlayerRankReset` per spec (with `rankResets PlayerRankReset[]` on `League` and `Player`)
- Produces (league helpers):
  - `ResolvedLeagueConfig.rankResetEnabled: boolean`
  - `ResolvedLeagueConfig.rankResetCooldownDays: number`
  - `setLeagueRankResetEnabled(leagueId: string, enabled: boolean, cooldownDays?: number): Promise<void>`
  - `setLeagueRankResetCooldownDays(leagueId: string, days: number): Promise<void>`

- [ ] **Step 1: Extend Prisma schema**

On `League`, after `lobbyPlayerClaimEnabled`:

```prisma
  rankResetEnabled      Boolean  @default(false)
  rankResetCooldownDays Int      @default(30)
```

Add relation array on `League`:

```prisma
  rankResets        PlayerRankReset[]
```

Add relation array on `Player`:

```prisma
  rankResets  PlayerRankReset[]
```

Add model (after `PlayerHeroRating` is fine):

```prisma
model PlayerRankReset {
  id              String   @id @default(cuid())
  leagueId        String
  playerId        String
  actorDiscordId  String
  targetDiscordId String?
  staffOverride   Boolean  @default(false)
  createdAt       DateTime @default(now())

  league League @relation(fields: [leagueId], references: [id], onDelete: Cascade)
  player Player @relation(fields: [playerId], references: [id], onDelete: Cascade)

  @@index([leagueId, playerId, createdAt])
  @@index([leagueId, createdAt])
}
```

- [ ] **Step 2: Create migration**

Run:

```bash
npx prisma migrate dev --name add_rank_reset
```

If the DB is unavailable, create `prisma/migrations/20260815170000_add_rank_reset/migration.sql` manually:

```sql
ALTER TABLE "League" ADD COLUMN "rankResetEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "League" ADD COLUMN "rankResetCooldownDays" INTEGER NOT NULL DEFAULT 30;

CREATE TABLE "PlayerRankReset" (
    "id" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "actorDiscordId" TEXT NOT NULL,
    "targetDiscordId" TEXT,
    "staffOverride" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlayerRankReset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlayerRankReset_leagueId_playerId_createdAt_idx" ON "PlayerRankReset"("leagueId", "playerId", "createdAt");
CREATE INDEX "PlayerRankReset_leagueId_createdAt_idx" ON "PlayerRankReset"("leagueId", "createdAt");

ALTER TABLE "PlayerRankReset" ADD CONSTRAINT "PlayerRankReset_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerRankReset" ADD CONSTRAINT "PlayerRankReset_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

Then run `npx prisma generate`.

- [ ] **Step 3: Extend league resolve + setters**

In `src/services/league/league-wc3stats.ts`, add to `ResolvedLeagueConfig`:

```typescript
rankResetEnabled: boolean;
rankResetCooldownDays: number;
```

In `resolveLeagueConfig` return:

```typescript
    rankResetEnabled: row?.rankResetEnabled === true,
    rankResetCooldownDays:
      row?.rankResetCooldownDays != null ? row.rankResetCooldownDays : 30,
```

Add setters that call `assertRankResetCooldownDays` from `../rating/rank-reset.js` (Task 2). If Task 1 lands first, temporarily duplicate the assert locally, then switch to the import in Task 2.

```typescript
export async function setLeagueRankResetEnabled(
  leagueId: string,
  enabled: boolean,
  cooldownDays?: number,
): Promise<void> {
  const data: { rankResetEnabled: boolean; rankResetCooldownDays?: number } = {
    rankResetEnabled: enabled,
  };
  if (cooldownDays !== undefined) {
    data.rankResetCooldownDays = assertRankResetCooldownDays(cooldownDays);
  }
  await prisma.league.update({ where: { id: leagueId }, data });
}

export async function setLeagueRankResetCooldownDays(
  leagueId: string,
  days: number,
): Promise<void> {
  const safe = assertRankResetCooldownDays(days);
  await prisma.league.update({
    where: { id: leagueId },
    data: { rankResetCooldownDays: safe },
  });
}
```

Re-export both from `src/services/league/index.ts`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/services/league/league-wc3stats.ts src/services/league/index.ts
git commit -m "feat: add league rank-reset schema and config setters"
```

---

### Task 2: Rank-reset use-case (eligibility + wipe)

**Files:**

- Create: `src/services/rating/rank-reset.ts`
- Create: `src/services/rating/rank-reset.test.ts`
- Modify: `src/services/rating/index.ts`
- Modify: `src/services/league/league-wc3stats.ts` (import `assertRankResetCooldownDays` if Task 1 used a local copy)

**Interfaces:**

- Produces:
  - `RANK_RESET_COOLDOWN_MIN_DAYS = 1`
  - `RANK_RESET_COOLDOWN_MAX_DAYS = 365`
  - `RANK_RESET_COOLDOWN_DEFAULT_DAYS = 30`
  - `class RankResetServiceError extends Error`
  - `assertRankResetCooldownDays(days: number): number`
  - `nextRankResetAt(lastResetAt: Date, cooldownDays: number): Date`
  - `isRankResetCooldownElapsed(lastResetAt: Date, cooldownDays: number, now?: Date): boolean`
  - `buildRankResetConfirmCustomId` / `buildRankResetCancelCustomId` / `parseRankResetButtonCustomId`
  - `previewRankReset(input: PreviewRankResetInput): Promise<RankResetPreview>`
  - `applyRankReset(input: ApplyRankResetInput): Promise<RankResetResult>`

Types:

```typescript
export type PreviewRankResetInput = {
  leagueId: string;
  actorDiscordId: string;
  targetDiscordId: string;
  memberRoleIds: string[];
  matchModRoleId?: string;
  now?: Date;
};

export type RankResetPreview = {
  leagueId: string;
  playerId: string;
  username: string;
  targetDiscordId: string;
  staffOverride: boolean;
  cooldownDays: number;
};

export type ApplyRankResetInput = PreviewRankResetInput & {
  expectedPlayerId?: string;
};

export type RankResetResult = {
  playerId: string;
  username: string;
  staffOverride: boolean;
};
```

- [ ] **Step 1: Write failing tests**

Create `src/services/rating/rank-reset.test.ts` covering:

1. `assertRankResetCooldownDays` accepts 1/365; rejects 0, 366, 1.5
2. `nextRankResetAt` / `isRankResetCooldownElapsed` day math
3. customId round-trip for confirm/cancel; invalid → null
4. `previewRankReset`: disabled → error; unlinked → error; active roster → error; self on cooldown → error with `<t:`; staff override on cooldown → ok with `staffOverride: true`
5. `applyRankReset`: upserts rating defaults, `deleteMany` heroes, creates audit with `staffOverride: false`

Mock `prisma` via `vi.hoisted` + `vi.mock('../../lib/prisma.js')`. Use real `assertHasMatchModRole` from match-auth (no mock) so mod role checks work.

See design error strings in the spec for exact `/i` matchers.

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm test -- src/services/rating/rank-reset.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/services/rating/rank-reset.ts`**

Constants / errors:

- Feature off: `Rank reset is disabled for this league.`
- Unlinked self: `Link your Discord with /link before resetting your rank.`
- Unlinked other: `That Discord user is not linked to a player. They must /link first.`
- Active roster: `You can't reset rank while that player is in an active lobby or match.`
- Cooldown: `You can reset again <t:UNIX:R>.`
- Cooldown range: `Rank reset cooldown must be between 1 and 365 days.`
- Player mismatch: `That rank reset confirmation is no longer valid.`

Logic:

1. `staffOverride = targetDiscordId !== actorDiscordId`; if true, `assertHasMatchModRole`
2. `prisma.player.findUnique({ where: { discordId: targetDiscordId } })`
3. Active check: `matchPlayer.findFirst` where `playerId` + `match.leagueId` + status in `PENDING`/`IN_PROGRESS`
4. If not staffOverride: latest `playerRankReset` by `createdAt desc`; if within cooldown, throw
5. `applyRankReset` calls `previewRankReset`, optional `expectedPlayerId` check, then `$transaction`: upsert `PlayerRating` μ25/σ8.333, `deleteMany` hero ratings, `create` audit row

CustomId format: `rank_reset:confirm|cancel:leagueId:playerId:actorDiscordId`

Export public API from `src/services/rating/index.ts`.

Wire league setters to import `assertRankResetCooldownDays`.

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm test -- src/services/rating/rank-reset.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/rank-reset.ts src/services/rating/rank-reset.test.ts src/services/rating/index.ts src/services/league/league-wc3stats.ts
git commit -m "feat: add rank-reset eligibility and wipe use-case"
```

---

### Task 3: Confirm/Cancel Discord interactions

**Files:**

- Create: `src/discord/interactions/rank-reset-interactions.ts`
- Modify: `src/events/interaction-create.ts`

**Interfaces:**

- Consumes: `applyRankReset`, `parseRankResetButtonCustomId`, `buildRankReset*CustomId`, `RankResetServiceError`, `refreshLeagueLeaderboard`, `resolveGuildConfig`, `MatchServiceError`, `prisma`
- Produces:
  - `buildRankResetConfirmComponents(input): ActionRowBuilder<ButtonBuilder>[]`
  - `handleRankResetInteraction(interaction): Promise<boolean>`

- [ ] **Step 1: Implement interaction handler**

`buildRankResetConfirmComponents`: Danger "Confirm reset" + Secondary "Cancel".

`handleRankResetInteraction`:

1. Only buttons whose `customId` starts with `rank_reset:`
2. Parse; if null, return true (consume)
3. If `interaction.user.id !== actorDiscordId` → ephemeral "Only the person who ran /rank_reset can use these buttons."
4. Cancel → `update` content `Rank reset cancelled.` + clear components
5. Confirm → `deferUpdate`; load player by `parsed.playerId`; if missing/`discordId` null → editReply error; else `applyRankReset` with `expectedPlayerId`; `refreshLeagueLeaderboard`; success copy (self vs staffOverride); catch `RankResetServiceError` | `MatchServiceError`

Use a **static** `import { prisma } from '../../lib/prisma.js'` (no dynamic import).

Copy `memberRoleIds` helper pattern from `src/commands/player/link.ts`.

Wire in `interaction-create.ts` before other component handlers:

```typescript
if (await handleRankResetInteraction(interaction)) {
  log.debug({ userId: interaction.user.id }, 'Rank reset interaction handled');
  return;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/discord/interactions/rank-reset-interactions.ts src/events/interaction-create.ts
git commit -m "feat: handle rank-reset confirm and cancel buttons"
```

---

### Task 4: `/rank_reset` slash command

**Files:**

- Create: `src/commands/player/rank-reset.ts`

**Interfaces:**

- Consumes: `previewRankReset`, league resolve helpers, `buildRankResetConfirmComponents`, `resolveGuildConfig`, `RankResetServiceError`, `MatchServiceError`
- Produces: slash command `rank_reset` (auto-loaded)

- [ ] **Step 1: Implement command**

`SlashCommandBuilder` name `rank_reset`, description about resetting overall and hero ki if enabled; optional `user`; wrap with `withOptionalLeagueOption`; export `autocomplete` via `respondLeagueAutocomplete`.

`execute`:

1. `deferReply({ ephemeral })`
2. Guild-only
3. `resolveLeagueIdFromInteraction`
4. `target = options.user ?? interaction.user`
5. `previewRankReset({ leagueId, actorDiscordId, targetDiscordId: target.id, memberRoleIds, matchModRoleId })`
6. Warning text (self vs staff) including cooldown days
7. `editReply` with warning + `buildRankResetConfirmComponents`
8. Catch `RankResetServiceError` | `MatchServiceError`

- [ ] **Step 2: Smoke-check**

```bash
npm test -- src/services/rating/rank-reset.test.ts
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/commands/player/rank-reset.ts
git commit -m "feat: add /rank_reset slash command with confirm prompt"
```

---

### Task 5: `/config` set + view

**Files:**

- Modify: `src/commands/config/config.ts`

**Interfaces:**

- Consumes: `setLeagueRankResetEnabled`, `setLeagueRankResetCooldownDays`, `resolveLeagueConfig`, `RankResetServiceError`

- [ ] **Step 1: Format + view**

```typescript
function formatRankResetLine(enabled: boolean, cooldownDays: number): string {
  return `**Rank reset:** \`${enabled ? 'on' : 'off'}\` · cooldown \`${cooldownDays}d\``;
}
```

Add to view content after player claim.

- [ ] **Step 2: Subcommands under `set`**

`rank_reset`: required `enabled` boolean; optional `cooldown_days` 1–365; league option.

`rank_reset_cooldown`: required `days` 1–365; league option.

- [ ] **Step 3: Handlers**

Call setters; on `RankResetServiceError` reply ephemeral; on success confirm enabled/disabled or new days; log info.

- [ ] **Step 4: Commit**

```bash
git add src/commands/config/config.ts
git commit -m "feat: config set/view for league rank reset"
```

---

### Task 6: Discord user docs

**Files:**

- Modify: `docs/discord/staff/a1-roles-and-setup.md`
- Modify: `docs/discord/staff/a5-admin-cheat-sheet.md`
- Modify: `docs/discord/public/06-rank-and-boards.md`

- [ ] **Step 1: Staff setup (`a1`)**

Document `/config set rank_reset`, optional `cooldown_days`, `/config set rank_reset_cooldown`, default off / 30 days, mod force-reset.

- [ ] **Step 2: Cheat sheet (`a5`)**

Config lines for rank_reset; mod line for `/rank_reset user:@…`.

- [ ] **Step 3: Public (`06`)**

Note some leagues offer `/rank_reset` with cooldown; cannot reset while in active lobby/match.

- [ ] **Step 4: Commit**

```bash
git add docs/discord/staff/a1-roles-and-setup.md docs/discord/staff/a5-admin-cheat-sheet.md docs/discord/public/06-rank-and-boards.md
git commit -m "docs: document league rank reset for staff and players"
```

---

### Task 7: Final verification

- [ ] **Step 1:** `npm test` — all pass
- [ ] **Step 2:** `npx tsc --noEmit` — exit 0
- [ ] **Step 3: Manual checklist on a dev bot**

1. `/config view` → Rank reset off · 30d
2. `/rank_reset` → disabled message
3. `/config set rank_reset enabled:True` → enabled
4. Linked self `/rank_reset` → confirm → ki ~1000, heroes gone
5. Immediate second self reset → cooldown message
6. Mod `/rank_reset user:@them` while on cooldown → works; their next self reset blocked
7. Join PENDING lobby → reset rejected
8. `/config set rank_reset enabled:False` → reject again

- [ ] **Step 4:** Commit any verification fixes if needed

---

## Spec coverage checklist

| Spec requirement                           | Task |
| ------------------------------------------ | ---- |
| League columns + defaults                  | 1    |
| `PlayerRankReset` audit table              | 1    |
| Cooldown from latest audit row             | 2    |
| Full wipe + transaction                    | 2    |
| Soft-hide / feature off                    | 2, 4 |
| Self + mod force + staffOverride           | 2, 4 |
| Active PENDING/IN_PROGRESS block           | 2    |
| Confirm/Cancel                             | 3, 4 |
| Live leaderboard refresh                   | 3    |
| `/config set rank_reset` + cooldown + view | 5    |
| Staff/public docs                          | 6    |

## Plan self-review notes

- Signatures aligned: `previewRankReset` / `applyRankReset` / customId helpers.
- Catch both `RankResetServiceError` and `MatchServiceError` in command + button handler.
- Task 3 uses static prisma import.
- Discord customId length stays under 100 chars with cuid + snowflakes.
