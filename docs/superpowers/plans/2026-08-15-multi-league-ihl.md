# Multi-League IHL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bot serve many Discord guilds with independent IHLs (`League` per guild+game), Elo/matches isolated per league, channel binding for day-to-day flows, and global slash commands — with WC3 UDBR as the only game wired end-to-end.

**Architecture:** Shared Postgres schema; global `Player` + `Hero`; tenant key `leagueId` on Match and both rating tables. `resolveLeagueContext` (explicit option → channel/category binding → single league → else require choice). Finish prerequisite wc3stats-on-`GuildConfig` is **done**; this plan migrates those columns onto `League`. Production registers commands via `Routes.applicationCommands`.

**Tech Stack:** Node.js + TypeScript ESM, discord.js v14, Prisma + PostgreSQL, Vitest, OpenTofu/Terraform SSM

**Spec:** [docs/superpowers/specs/2026-08-15-multi-league-ihl-design.md](../specs/2026-08-15-multi-league-ihl-design.md)

**Prerequisite:** Guild wc3stats config slice merged (`GuildConfig.wc3stats*`, env keys removed). Do not re-implement that slice.

## Global Constraints

- Scope labels: every task is `general` unless marked `game:warcraft3_udbr` — see `.cursor/rules/feature-scope-game-vs-general.mdc`
- User-facing strings in **English**
- Elo and match history **never** cross `leagueId`
- `Player.username` / `Player.discordId` stay globally unique (one Discord link)
- Create/mod roles stay on `GuildConfig` this slice (guild-wide)
- No schema-per-tenant; no RLS as primary isolation
- Second game not implemented — only seams + `docs/dev/adding-a-new-game.md`
- ESM imports use `.js` extensions; Prisma singleton from `src/lib/prisma.ts`
- Prefer `MatchServiceError` for user-facing failures
- Commits only when the user asks (skip commit steps unless requested)
- Legacy backfill: all existing `Match` + rating rows belong to one historical IHL — assign to the default league of `MULTI_LEAGUE_LEGACY_GUILD_ID` (migration/env at migrate time; typically former prod `GUILD_ID`)

## File structure

| File | Responsibility |
|------|----------------|
| `prisma/schema.prisma` + migrations | `Game`, `League`, `LeagueChannelBinding`, `leagueId` on Match/ratings; move wc3stats/leaderboard onto League |
| `src/domain/games.ts` | `WARCRAFT3_UDBR_GAME_ID` constant |
| `src/services/league/league.ts` | CRUD league, ensure default, list by guild |
| `src/services/league/league-resolve.ts` | `resolveLeagueContext` |
| `src/services/league/league-binding.ts` | Bind/unbind channel/category |
| `src/services/league/league-wc3stats.ts` | `game:warcraft3_udbr` — preset/clear/resolve filter on League |
| `src/services/rating/*` | All reads/writes take `leagueId` |
| `src/services/match/*` | `createPendingMatch` requires `leagueId`; wc3stats active id unique per league |
| `src/services/leaderboard/*` | Filter by `leagueId`; live board ids on League |
| `src/services/player/player-profile.ts` | Rank within league |
| `src/commands/league/*` + `config.ts` | Staff create/bind; wc3stats preset on resolved league |
| `src/handlers/register-commands.ts` | Global vs guild deploy |
| `src/config/env.ts` + AWS | Optional `GUILD_ID` |
| `docs/dev/adding-a-new-game.md` | Already drafted — verify against final APIs |
| `.cursor/rules/feature-scope-game-vs-general.mdc` | Already drafted — keep |
| `.cursor/rules/database-domain.mdc` | Document League tenancy |

---

### Task 1: Game constant + Prisma `Game` / `League` / bindings (ratings still global)

**Scope:** `general`

**Files:**
- Create: `src/domain/games.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_multi_league_core/migration.sql`

**Interfaces:**
- Produces: `WARCRAFT3_UDBR_GAME_ID = 'warcraft3_udbr'`
- Produces models: `Game`, `League` (without wc3stats columns yet), `LeagueChannelBinding`, enum `LeagueBindingKind`
- Produces: `Match.leagueId String?` temporarily nullable for backfill in Task 2

- [ ] **Step 1: Add game id constant**

```typescript
/** Catalog id for Ultimate Dragon Ball Reborn (Warcraft III). */
export const WARCRAFT3_UDBR_GAME_ID = 'warcraft3_udbr' as const;

export type KnownGameId = typeof WARCRAFT3_UDBR_GAME_ID;
```

- [ ] **Step 2: Extend Prisma schema**

Add `Game`, `League`, `LeagueChannelBinding`, `LeagueBindingKind` per spec sketch (League **without** wc3stats/leaderboard columns yet — those move in Task 3).

On `Match` add:

```prisma
  leagueId String?
  league   League? @relation(fields: [leagueId], references: [id], onDelete: Restrict)

  @@index([leagueId, status])
  @@index([leagueId, wc3statsGameId])
```

Seed in migration SQL:

```sql
INSERT INTO "Game" ("id", "displayName") VALUES ('warcraft3_udbr', 'Warcraft III — UDBR');
```

- [ ] **Step 3: Create migration**

Run: `npm run db:migrate`  
Name: `multi_league_core`

- [ ] **Step 4: Commit** (only if user asked)

```bash
git add prisma src/domain/games.ts
git commit -m "$(cat <<'EOF'
Add Game/League schema foundation for multi-IHL tenancy.

EOF
)"
```

---

### Task 2: Backfill leagues + `Match.leagueId` NOT NULL + guild-scoped ratings

**Scope:** `general`

**Files:**
- Create: `prisma/migrations/<timestamp>_multi_league_ratings_backfill/migration.sql`
- Modify: `prisma/schema.prisma` (`PlayerRating`, `PlayerHeroRating`, `Match.leagueId`)

**Interfaces:**
- Produces: `PlayerRating` PK `(leagueId, playerId)`; `PlayerHeroRating` PK `(leagueId, playerId, heroId)`
- Produces: `Match.leagueId` required
- Migration reads env `MULTI_LEAGUE_LEGACY_GUILD_ID` **or** document that SQL uses a placeholder replaced in ops notes — prefer embedding the known prod snowflake only via a one-shot SQL comment and requiring the deploy host to set it:

```sql
-- Replace :legacy_guild_id before apply in non-local envs (former GUILD_ID).
```

For local/dev: use whatever `GUILD_ID` is in `.env`.

**Backfill algorithm (SQL or Prisma script `scripts/backfill-leagues.ts` run once):**

1. For every distinct `GuildConfig.guildId`, insert `League` (`gameId=warcraft3_udbr`, `name='UDBR'`).
2. If `MULTI_LEAGUE_LEGACY_GUILD_ID` has no `GuildConfig` row, upsert `GuildConfig` + create its league.
3. Create temp table mapping `guildId → leagueId`.
4. `UPDATE "Match" SET "leagueId" = <legacy league>` for **all** existing matches (single-tenant era).
5. Rebuild ratings:
   - Create new tables or add `leagueId`, copy rows with legacy `leagueId`, drop old PKs, swap.
6. `ALTER TABLE "Match" ALTER COLUMN "leagueId" SET NOT NULL`.

- [ ] **Step 1: Write a Vitest that documents the intended PK shape** (unit-level, can wait until app code exists — or skip to SQL first). Prefer implementing SQL migration carefully, then Task 5 tests isolation.

- [ ] **Step 2: Author migration SQL / script and apply**

Run: `npm run db:migrate` or `npx tsx scripts/backfill-leagues.ts` then migrate.

Expected: every match has `leagueId`; every rating row has `leagueId`; empty guilds with config have a league and zero ratings.

- [ ] **Step 3: Update `schema.prisma` to final PKs** matching DB.

```prisma
model PlayerRating {
  leagueId  String
  playerId  String
  mu        Float    @default(25.0)
  sigma     Float    @default(8.333)
  updatedAt DateTime @updatedAt
  league    League   @relation(...)
  player    Player   @relation(...)
  @@id([leagueId, playerId])
  @@index([leagueId])
}

model PlayerHeroRating {
  leagueId      String
  playerId      String
  heroId        Int
  mu            Float @default(25.0)
  sigma         Float @default(8.333)
  matchesPlayed Int   @default(0)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  league        League @relation(...)
  player        Player @relation(...)
  hero          Hero   @relation(...)
  @@id([leagueId, playerId, heroId])
  @@index([leagueId, playerId])
  @@index([leagueId, heroId])
}
```

Update `Player.ratings` / `heroRatings` relations (already arrays — now honest).

- [ ] **Step 4: `npx prisma generate` + note ops**

Document in plan PR: set `MULTI_LEAGUE_LEGACY_GUILD_ID` before migrate on prod.

- [ ] **Step 5: Commit** (only if user asked)

```bash
git commit -m "$(cat <<'EOF'
Backfill leagues and scope Match/ratings by leagueId.

EOF
)"
```

---

### Task 3: Move wc3stats + leaderboard fields onto `League` (`game:warcraft3_udbr` + `general`)

**Scope:** mixed — schema/move `general`; preset helpers `game:warcraft3_udbr`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: migration `multi_league_move_guild_config_ihl_fields`
- Create: `src/services/league/league-wc3stats.ts`
- Modify: `src/services/wc3stats/wc3stats-slot-map.ts` (league-scoped load/replace/clear)
- Modify: `src/services/guild/guild-config.ts` — remove wc3stats resolve fields; keep roles/claim
- Modify: `src/services/leaderboard/leaderboard-channel.ts` — read/write League board ids
- Modify tests accordingly

**Interfaces:**
- Produces on `League`:

```prisma
  wc3statsEnabled         Boolean @default(false)
  wc3statsMapPattern      String?
  wc3statsMapSha1         String?
  leaderboardChannelId    String?
  leaderboardMessageId    String?
  lobbyPlayerClaimEnabled Boolean @default(true)
```

- Rename table conceptually: `GuildWc3statsSlotMap` → `LeagueWc3statsSlotMap` with `leagueId` PK part
- Produces:

```typescript
export async function applyUdbrWc3statsPreset(leagueId: string): Promise<void>
export async function clearLeagueWc3statsPackage(leagueId: string): Promise<void>
export function isLeagueWc3statsImportReady(league: {
  wc3statsEnabled: boolean;
  wc3statsMapPattern: string | undefined;
}): boolean
```

- [ ] **Step 1: Migration SQL**

For each `GuildConfig` with a matching `League` (same `guildId`, `gameId=warcraft3_udbr`, `name='UDBR'`): copy wc3stats + leaderboard + claim columns; copy slot map rows to `LeagueWc3statsSlotMap`; drop old columns/table FKs from guild.

- [ ] **Step 2: Implement `league-wc3stats.ts`**

Mirror former `applyUdbrWc3statsPreset(guildId)` / `clearGuildWc3statsPackage` but `where: { id: leagueId }`.

- [ ] **Step 3: Update slot-map helpers** to `loadLeagueWc3statsHeroSlotMap(leagueId)` etc.; keep thin wrappers only if needed during transition, then delete guild versions.

- [ ] **Step 4: Strip wc3stats from `ResolvedGuildConfig`** and all callers (will be rewired in Tasks 6–7 to league).

Temporarily, if compile breaks, fix call sites to resolve league via “single league in guild” helper `getSoleLeagueOrThrow(guildId)` until Task 4 lands — prefer finishing Task 4 before merging Task 3 if the branch cannot compile mid-way. **Recommended order on the branch:** land Task 4 resolve next in the same PR series before deleting guild wc3stats APIs.

- [ ] **Step 5: Tests** for preset/clear on league id.

- [ ] **Step 6: Commit** (only if user asked)

---

### Task 4: `resolveLeagueContext` + binding CRUD

**Scope:** `general`

**Files:**
- Create: `src/services/league/league-resolve.ts`
- Create: `src/services/league/league-resolve.test.ts`
- Create: `src/services/league/league-binding.ts`
- Create: `src/services/league/league.ts` (`createLeague`, `listLeaguesForGuild`, `getLeagueById`)
- Create: `src/services/league/league-errors.ts` (or reuse `MatchServiceError` messages)

**Interfaces:**

```typescript
export type LeagueResolveInput = {
  guildId: string;
  channelId?: string | null;
  categoryId?: string | null; // parent of channel, if known
  leagueIdOption?: string | null;
};

export type LeagueResolveResult =
  | { ok: true; league: League }
  | { ok: false; reason: 'no_leagues' | 'ambiguous' | 'invalid_option' | 'not_in_guild' };

export async function resolveLeagueContext(
  input: LeagueResolveInput,
): Promise<LeagueResolveResult>

export async function bindDiscordToLeague(input: {
  leagueId: string;
  discordId: string;
  kind: 'CHANNEL' | 'CATEGORY';
}): Promise<void>

export async function unbindDiscord(discordId: string): Promise<boolean>
```

**Resolution order (exact):**
1. `leagueIdOption` present → load; must `league.guildId === input.guildId`
2. Else binding on `channelId` (kind CHANNEL)
3. Else binding on `categoryId` (kind CATEGORY)
4. Else if exactly one league for guild → that league
5. Else `ambiguous` or `no_leagues`

- [ ] **Step 1: Write failing tests** for all five paths + “channel wins over category”.

- [ ] **Step 2: Implement resolve + binding**

- [ ] **Step 3: Tests pass**

Run: `npx vitest run src/services/league/league-resolve.test.ts`

- [ ] **Step 4: Commit** (only if user asked)

---

### Task 5: Thread `leagueId` through ratings + match create/report

**Scope:** `general`

**Files:**
- Modify: `src/services/rating/rating-preview.ts` — `ensurePlayerRatings(leagueId, …)`, `loadLobbyRatingPreview`, `loadPlayerKiBySlot`
- Modify: `src/services/rating/rating-update.ts` — `applyMatchRatings(leagueId, …)`, `applyQuitterPenalties(leagueId, …)`
- Modify: `src/services/match/match-report.ts` — pass `match.leagueId`
- Modify: `src/services/match/match-service.ts` — `CreatePendingMatchInput.leagueId: string`; create with `leagueId`; `findActiveMatchByWc3statsGameId(leagueId, gameId)`; duplicate check scoped by league
- Modify: colocated `*.test.ts`

**Interfaces:**

```typescript
// rating-preview.ts
export async function ensurePlayerRatings(
  leagueId: string,
  entries: { playerId: string; heroId: number }[],
  db?: Db,
): Promise<void>

// rating-update.ts
export async function applyMatchRatings(
  leagueId: string,
  entries: RatingRosterEntry[],
  winningTeam: 1 | 2,
  db?: Db,
): Promise<void>

// match-service.ts
export interface CreatePendingMatchInput {
  leagueId: string;
  hostDiscordId: string;
  discordChannelId: string;
  players: LobbyPlayer[];
  wc3statsGameId?: string;
}
```

Every `playerRating` / `playerHeroRating` query must include `leagueId` in `where` / compound id.

- [ ] **Step 1: Update unit tests to pass `leagueId` (expect FAIL on old signatures)**

- [ ] **Step 2: Implement signature + query changes**

- [ ] **Step 3: Isolation test** — two leagues, same `playerId`, apply ratings in A, assert B unchanged.

```typescript
it('does not mutate ratings in another league', async () => {
  // arrange two leagues, same playerId cold-start rows
  await applyMatchRatings(leagueA, roster, 1, tx);
  const b = await tx.playerRating.findUnique({
    where: { leagueId_playerId: { leagueId: leagueB, playerId } },
  });
  expect(b?.mu).toBe(25);
});
```

(Use existing prisma mock patterns in `rating-update.test.ts`.)

- [ ] **Step 4: Full rating/match test suite green**

Run: `npx vitest run src/services/rating src/services/match`

- [ ] **Step 5: Commit** (only if user asked)

---

### Task 6: Leaderboard + rank + live board per league

**Scope:** `general`

**Files:**
- Modify: `src/services/leaderboard/leaderboard.ts` — all loaders take `leagueId`
- Modify: `src/services/leaderboard/leaderboard-channel.ts` — store ids on `League`; `refreshAllLeaderboardChannels` iterates leagues with a channel set
- Modify: `src/services/player/player-profile.ts` — `loadPlayerProfile(lookup, leagueId)`
- Modify: `src/commands/player/rank.ts`, `leaderboard.ts`
- Modify: `src/discord/interactions/leaderboard-interactions.ts`
- Modify: match report paths that call `refreshAllLeaderboardChannels`

**Interfaces:**

```typescript
export async function loadOverallLeaderboardPage(
  leagueId: string,
  page: number,
): Promise<OverallLeaderboardPage>

export async function loadPlayerProfile(
  lookup: RankLookup,
  leagueId: string,
): Promise<PlayerProfile>
```

- [ ] **Step 1: Fail tests / update signatures**

- [ ] **Step 2: Filter all rating queries with `where: { leagueId }`**

- [ ] **Step 3: Wire commands through `resolveLeagueContext`**

On ambiguity: ephemeral English message asking for `league:` option (add optional slash option to `/rank` and `/leaderboard`).

- [ ] **Step 4: Tests + commit** (if asked)

---

### Task 7: Lobby register / refresh / config wc3stats on resolved league

**Scope:** `general` + `game:warcraft3_udbr` for preset handlers

**Files:**
- Modify: `src/commands/lobby/register-lobby.ts`
- Modify: `src/services/lobby/wc3stats-refresh.ts`
- Modify: `src/services/lobby/discord-sync.ts`
- Modify: `src/commands/config/config.ts` — preset/clear/view wc3stats via resolved league
- Modify: claim helpers if claim flag moved to league

**Behavior:**
- `/register_lobby`: `resolveLeagueContext` from interaction channel; on failure, refuse (“Bind this channel to a league or pass league:”). Pass `leagueId` into `createPendingMatch` and wc3stats import readiness from league row.
- `/config set wc3stats_map_preset`: resolve league (prefer `league:` option; else channel binding / sole league).
- View shows league name + wc3stats fields from league.

- [ ] **Step 1: Wire register-lobby**

- [ ] **Step 2: Wire refresh + discord-sync**

- [ ] **Step 3: Wire `/config` wc3stats to `league-wc3stats.ts`**

- [ ] **Step 4: Manual sanity checklist in PR**

- [ ] **Step 5: Commit** (if asked)

---

### Task 8: Staff commands — create league + bind channel/category

**Scope:** `general`

**Files:**
- Create: `src/commands/league/league.ts` (or `/config` subcommands — prefer `/league` group: `create`, `list`, `bind`, `unbind`)
- Auth: same as `assertCanConfigureBot`

**Slash surface:**

| Subcommand | Options | Effect |
|------------|---------|--------|
| `create` | `game:` (choices: UDBR only), `name:` | Insert League |
| `list` | — | Ephemeral list |
| `bind` | `target:` channel, optional `league:` | CHANNEL binding (derive category bind via separate subcommand or `type` option) |
| `unbind` | `target:` channel/category | Remove binding |

- [ ] **Step 1: Implement command + wire into command loader**

- [ ] **Step 2: Autocomplete for `league:`** listing leagues in `interaction.guildId`

- [ ] **Step 3: Smoke test create → bind → register_lobby resolves**

- [ ] **Step 4: Commit** (if asked)

---

### Task 9: Global slash command deploy + optional `GUILD_ID`

**Scope:** `general`

**Files:**
- Modify: `src/handlers/register-commands.ts`
- Modify: `src/config/env.ts`
- Modify: `.env.example`, `.cursor/rules/scripts-and-env.mdc`
- Modify: `deploy/aws/refresh-env.sh`, `infra/aws/variables.tf`, `ssm.tf`, `terraform.tfvars.example` — `GUILD_ID` optional / empty sentinel
- Follow `env-aws-sync.mdc` for optional empty string → `__EMPTY__`

**Interfaces:**

```typescript
// env.ts
guildId: string | undefined; // optional

// register-commands.ts
export async function registerCommands(): Promise<number> {
  const commands = await getCommandPayloads();
  const rest = new REST().setToken(env.discordToken);
  if (env.guildId) {
    await rest.put(Routes.applicationGuildCommands(env.clientId, env.guildId), { body: commands });
  } else {
    await rest.put(Routes.applicationCommands(env.clientId), { body: commands });
  }
  return commands.length;
}

export async function clearGuildCommands(guildId: string): Promise<void> {
  const rest = new REST().setToken(env.discordToken);
  await rest.put(Routes.applicationGuildCommands(env.clientId, guildId), { body: [] });
}
```

- [ ] **Step 1: Make `GUILD_ID` optional in `env.ts`**

```typescript
guildId: process.env.GUILD_ID?.trim() || undefined,
```

- [ ] **Step 2: Dual-path `registerCommands`**

- [ ] **Step 3: Ops note** — after first prod global deploy, run clear on former guild id once.

- [ ] **Step 4: AWS optional key**

- [ ] **Step 5: Commit** (if asked)

---

### Task 10: Docs, domain rule, self-check

**Scope:** `general`

**Files:**
- Verify: `docs/dev/adding-a-new-game.md` (already present — update API names to match final exports)
- Verify: `.cursor/rules/feature-scope-game-vs-general.mdc` + `CLAUDE.md`
- Modify: `.cursor/rules/database-domain.mdc` — document `Game` / `League` / ratings PK
- Modify: `.cursor/rules/openskill-rating.mdc` — “global rating” means league-global, not cross-server
- Optional: staff doc note for `/league` bind

- [x] **Step 1: Align adding-a-new-game.md with real function names**

- [x] **Step 2: Update database-domain + openskill rules**

- [x] **Step 3: Grep guardrails**

```bash
rg -n "playerRating\.(findMany|findUnique|update|upsert)" src/ | head
# Every hit must show leagueId in the same call site
rg -n "env\.guildId" src/
# Only register-commands / deploy should care; business logic must not
rg -n "WC3STATS_ENABLED|wc3statsEnabled.*GuildConfig" src/
```

- [x] **Step 4: Full test + typecheck**

Run: `npm test && npm run build`

- [ ] **Step 5: Commit** (if asked)

---

## Ops checklist (post-deploy)

1. Run migrations with `MULTI_LEAGUE_LEGACY_GUILD_ID` set to former prod guild snowflake.  
2. Deploy bot; run `deploy-commands` **without** `GUILD_ID` (global).  
3. Clear old guild command set once.  
4. In each active guild: `/league list` → bind lobby channels → confirm `/register_lobby` → `/rank`.  
5. Re-run UDBR preset on league if wc3stats import needed after column move.  
6. Verify second guild the bot is in sees slash commands and has isolated Elo.

## Out of scope (do not implement in this plan)

- Second game end-to-end  
- Per-league create/mod roles  
- Fat presets (heroes/team names)  
- RLS / multi-schema  

---

## Self-review (plan author)

| Spec requirement | Task |
|------------------|------|
| Shared schema + leagueId ratings/matches | 1–2, 5 |
| Channel binding + resolve chain | 4, 7–8 |
| Migrate wc3stats GuildConfig → League | 3 |
| Leaderboard per league | 6 |
| Global commands / optional GUILD_ID | 9 |
| adding-a-new-game + scope rule | 10 (drafts already on disk) |
| Finish wc3stats prerequisite first | Done before this plan |
| No second game / no RLS | Honored in non-goals |
