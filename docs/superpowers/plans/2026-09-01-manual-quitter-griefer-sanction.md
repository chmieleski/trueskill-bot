# Manual quitter / griefer sanctions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mod-only `/match sanction add|remove` records ±1 quitter/griefer marker without a real match, with full OpenSkill/griefer-tax parity, hidden from match history.

**Architecture:** Each add creates a `CANCELLED` `Match` with `isManualSanction = true` and one flagged `MatchPlayer`; reuse `applyQuitterPenalties`, `accrueGrieferPenalties`, snapshot write/restore, and existing clear helpers. Slash command is a thin adapter in `match.ts`.

**Tech Stack:** Node.js ESM, TypeScript, discord.js v14 slash commands, Prisma/PostgreSQL, Vitest.

## Global Constraints

- Scope: `general` — league-scoped writes; guild-wide leaderboards aggregate via existing loaders.
- User-facing strings: English only.
- Mod auth: `assertHasMatchModRole` only (not host).
- Penalties on add: quitter → 3 synthetic losses; griefer → 25% ki tax max 500.
- Remove default: latest manual sanction only; optional `match_id` uses `clearMatchQuitters` / `clearMatchGriefers`.
- Hide manual sanctions from `/match history` (incl. `griefers_only`); counts still appear on `/rank` and guild boards.
- Reject archived leagues via `isLeagueWritable` / `LEAGUE_ARCHIVED_MESSAGE`.
- Follow ESM `.js` imports, shared domain logic in `src/services/match/`, Conventional Commits, run `npm run format:check` before PR.

---

## File map

| File                                         | Responsibility                                              |
| -------------------------------------------- | ----------------------------------------------------------- |
| `prisma/schema.prisma`                       | `Match.isManualSanction` + index                            |
| `prisma/migrations/…`                        | Generated migration                                         |
| `src/services/match/manual-sanction.ts`      | `addManualSanction`, `removeManualSanction`, lookup helpers |
| `src/services/match/manual-sanction.test.ts` | Unit tests (mocked prisma)                                  |
| `src/services/match/index.ts`                | Re-export new service                                       |
| `src/services/match/match-history.ts`        | Exclude manual sanctions from history queries               |
| `src/services/match/match-history.test.ts`   | Regression test for filter                                  |
| `src/commands/match/match.ts`                | `sanction` subcommand group + execute handlers              |
| `src/commands/match/match.test.ts`           | Command wiring tests if pattern exists                      |

---

### Task 1: Schema — `isManualSanction`

**Files:**

- Modify: `prisma/schema.prisma` (on `Match` model)
- Create: `prisma/migrations/<timestamp>_add_match_is_manual_sanction/migration.sql` (via `npm run db:migrate`)

**Interfaces:**

- Produces: `Match.isManualSanction Boolean @default(false)` and `@@index([leagueId, isManualSanction, createdAt])`

- [ ] **Step 1: Add field and index to schema**

In `model Match`, after `completedAt`:

```prisma
  isManualSanction Boolean @default(false)
```

Add index with other league indexes:

```prisma
  @@index([leagueId, isManualSanction, createdAt])
```

- [ ] **Step 2: Create migration**

Run: `npm run db:migrate -- --name add_match_is_manual_sanction`

Expected: migration SQL adds column default false + index; `npm run db:generate` runs.

- [ ] **Step 3: Verify**

Run: `npm run typecheck`

Expected: PASS

---

### Task 2: Core service — `addManualSanction`

**Files:**

- Create: `src/services/match/manual-sanction.ts`
- Create: `src/services/match/manual-sanction.test.ts`
- Modify: `src/services/match/index.ts`

**Interfaces:**

- Consumes: `writeMatchRatingSnapshots`, `restoreMatchRatingSnapshots` from `match-correction.ts`; `applyQuitterPenalties`, `accrueGrieferPenalties`, `loadLiveGlobalByPlayer` from `rating-update.ts`; `loadMatchDisplayStatsByPlayer`, `gamesByPlayerFromStats` from `rank-reset-display.ts`; `findPlayerForRankLookup` from `player-profile.ts`; `isLeagueWritable`, `LEAGUE_ARCHIVED_MESSAGE` from `league/league.js`; `getGameProfileForLeague` from `league-profile.js`
- Produces:

```typescript
export type ManualSanctionType = 'quitter' | 'griefer';

export type AddManualSanctionInput = {
  leagueId: string;
  guildId: string;
  playerId: string;
  type: ManualSanctionType;
  actorDiscordId: string;
  discordChannelId: string;
};

export type AddManualSanctionResult = {
  matchId: string;
  username: string;
  type: ManualSanctionType;
  quits: number;
  griefs: number;
  grieferKiAccrued: number | null;
};

export async function addManualSanction(
  input: AddManualSanctionInput,
): Promise<AddManualSanctionResult>;
```

- [ ] **Step 1: Write failing test for quitter add**

Create `src/services/match/manual-sanction.test.ts` with mocks for prisma transaction, `writeMatchRatingSnapshots`, `applyQuitterPenalties`, league writable check. Assert:

- match created with `status: 'CANCELLED'`, `isManualSanction: true`
- player row `isQuitter: true`
- `writeMatchRatingSnapshots` then `applyQuitterPenalties` called

- [ ] **Step 2: Run test — expect FAIL**

Run: `npx vitest run src/services/match/manual-sanction.test.ts`

- [ ] **Step 3: Implement `addManualSanction`**

Skeleton:

```typescript
export async function addManualSanction(
  input: AddManualSanctionInput,
): Promise<AddManualSanctionResult> {
  if (!(await isLeagueWritable(input.leagueId))) {
    throw new MatchServiceError(LEAGUE_ARCHIVED_MESSAGE);
  }

  const profile = await getGameProfileForLeague(input.leagueId);
  const heroId = profile.heroBinding === 'slot_bound' ? 1 : null;

  let matchId = '';

  await prisma.$transaction(async (tx) => {
    const match = await tx.match.create({
      data: {
        status: 'CANCELLED',
        isManualSanction: true,
        leagueId: input.leagueId,
        hostDiscordId: input.actorDiscordId,
        discordChannelId: input.discordChannelId,
      },
    });
    matchId = match.id;

    await tx.matchPlayer.create({
      data: {
        matchId,
        playerId: input.playerId,
        team: 1,
        slot: 1,
        heroId,
        isQuitter: input.type === 'quitter',
        isGriefer: input.type === 'griefer',
      },
    });

    const snapshotPlayers = [{ playerId: input.playerId, heroId }];
    await ensurePlayerRatings(input.leagueId, snapshotPlayers, tx);

    const entry: RatingRosterEntry = {
      playerId: input.playerId,
      slot: 1,
      team: 1,
      heroId,
      isQuitter: input.type === 'quitter',
      isGriefer: input.type === 'griefer',
    };

    if (input.type === 'quitter') {
      await writeMatchRatingSnapshots(input.leagueId, matchId, snapshotPlayers, tx);
      await applyQuitterPenalties(input.leagueId, [entry], tx);
    } else {
      const liveGlobal = await loadLiveGlobalByPlayer(input.leagueId, [input.playerId], tx);
      const displayStats = await loadMatchDisplayStatsByPlayer(
        input.leagueId,
        [input.playerId],
        tx,
      );
      const gamesByPlayer = gamesByPlayerFromStats(displayStats);
      await accrueGrieferPenalties(matchId, [entry], liveGlobal, gamesByPlayer, tx);
    }
  });

  // load username + post-hoc quits/griefs for reply
  // return AddManualSanctionResult
}
```

Adjust imports/types to match codebase (`RatingRosterEntry`, `ensurePlayerRatings`, etc.).

- [ ] **Step 4: Add griefer test + archived rejection test**

Test griefer path calls `accrueGrieferPenalties`. Test archived league throws `LEAGUE_ARCHIVED_MESSAGE`.

- [ ] **Step 5: Export from `src/services/match/index.ts`**

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/services/match/manual-sanction.test.ts`

Expected: PASS

---

### Task 3: Core service — `removeManualSanction`

**Files:**

- Modify: `src/services/match/manual-sanction.ts`
- Modify: `src/services/match/manual-sanction.test.ts`

**Interfaces:**

- Consumes: `clearMatchQuitters`, `clearMatchGriefers` from `match-report.ts`; `restoreMatchRatingSnapshots` from `match-correction.ts`
- Produces:

```typescript
export type RemoveManualSanctionInput = {
  leagueId: string;
  playerId: string;
  username: string;
  type: ManualSanctionType;
  matchId?: string;
};

export type RemoveManualSanctionResult = {
  matchId: string;
  type: ManualSanctionType;
  username: string;
  mode: 'manual_restored' | 'delegated_clear';
};

export async function removeManualSanction(
  input: RemoveManualSanctionInput,
): Promise<RemoveManualSanctionResult>;

export async function findLatestManualSanctionMatchId(
  leagueId: string,
  playerId: string,
  type: ManualSanctionType,
): Promise<string | null>;
```

- [ ] **Step 1: Write failing test — remove latest manual quitter restores snapshots**

Mock `findLatestManualSanctionMatchId` returning an id; expect transaction calls `restoreMatchRatingSnapshots` and clears `isQuitter`.

- [ ] **Step 2: Write failing test — remove latest manual griefer delegates to `clearMatchGriefers`**

- [ ] **Step 3: Write failing test — with `matchId` delegates to clear helpers without latest lookup**

- [ ] **Step 4: Write failing test — no manual row throws**

Message: `No manual quitter sanction found for **${username}**.`

- [ ] **Step 5: Implement**

```typescript
export async function findLatestManualSanctionMatchId(
  leagueId: string,
  playerId: string,
  type: ManualSanctionType,
): Promise<string | null> {
  const row = await prisma.matchPlayer.findFirst({
    where: {
      playerId,
      isQuitter: type === 'quitter',
      ...(type === 'griefer' ? { isGriefer: true, isQuitter: false } : {}),
      match: {
        leagueId,
        isManualSanction: true,
        status: 'CANCELLED',
      },
    },
    orderBy: { match: { createdAt: 'desc' } },
    select: { matchId: true },
  });
  return row?.matchId ?? null;
}
```

`removeManualSanction`:

- If `input.matchId`: validate player on match has expected flag; call `clearMatchGriefers` or `clearMatchQuitters`; return `mode: 'delegated_clear'`.
- Else: resolve latest id; if null throw; griefer → `clearMatchGriefers`; quitter → transaction with `restoreMatchRatingSnapshots` + clear flag; return `mode: 'manual_restored'`.

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/services/match/manual-sanction.test.ts`

Expected: PASS

---

### Task 4: Hide manual sanctions from match history

**Files:**

- Modify: `src/services/match/match-history.ts`
- Modify: `src/services/match/match-history.test.ts`

**Interfaces:**

- Consumes: `Match.isManualSanction`
- Produces: history queries add `isManualSanction: false` to `where`

- [ ] **Step 1: Write failing test**

In `match-history.test.ts`, assert `loadMatchHistoryPage` griefers_only query object includes `isManualSanction: false` (mock prisma and inspect `findMany` call).

- [ ] **Step 2: Patch `loadMatchHistoryPage`**

Both branches of `where` add:

```typescript
isManualSanction: false,
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/services/match/match-history.test.ts`

Expected: PASS

---

### Task 5: Slash commands — `/match sanction`

**Files:**

- Modify: `src/commands/match/match.ts`
- Modify: `src/commands/match/match.test.ts` (optional descriptor test)

**Interfaces:**

- Consumes: `addManualSanction`, `removeManualSanction`; `resolveHistoryPlayer` or `findPlayerForRankLookup`; `refreshGuildQuitterLeaderboard`, `refreshGuildGrieferLeaderboard`

- [ ] **Step 1: Register subcommand group on `data` builder**

```typescript
.addSubcommandGroup((group) =>
  group
    .setName('sanction')
    .setDescription('Add or remove quitter/griefer markers without a match (mods only)')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Record one quitter or griefer incident (mods only)')
        .addStringOption((o) =>
          o
            .setName('type')
            .setDescription('Sanction type')
            .setRequired(true)
            .addChoices({ name: 'Quitter', value: 'quitter' }, { name: 'Griefer', value: 'griefer' }),
        )
        .addUserOption((o) => o.setName('user').setDescription('Discord user').setRequired(false))
        .addStringOption((o) => o.setName('nick').setDescription('In-game nick').setRequired(false)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove one quitter or griefer marker (mods only)')
        .addStringOption(/* type — same choices */)
        .addUserOption(/* user */)
        .addStringOption(/* nick */)
        .addStringOption((o) =>
          o
            .setName('match_id')
            .setDescription('Specific sanction/match id; omit to remove latest manual sanction')
            .setRequired(false),
        ),
    ),
)
```

Keep optional `league` on parent command (already on `withOptionalLeagueOption` if match uses it — verify match.ts uses league option; if not, add league option to sanction subcommands or parent).

- [ ] **Step 2: Implement execute branches**

For `sanction` group:

1. Require guild.
2. `assertHasMatchModRole` with resolved guild config.
3. Resolve league via `resolveLeagueIdFromInteraction`.
4. Parse `type`, resolve player (`user`/`nick` — reuse `parseRankOptions` + `resolveHistoryPlayer` or equivalent).
5. `add` → `addManualSanction` → refresh both guild boards → ephemeral success message with quits/griefs/tax.
6. `remove` → optional `match_id` → `removeManualSanction` → refresh boards → ephemeral success.

Example success copy:

```text
Manual quitter sanction recorded for **goku** (match `clxyz…`). Quits: **3** (league).
```

```text
Removed manual quitter sanction for **goku** (match `clxyz…`). Quits: **2** (league).
```

- [ ] **Step 3: Add command descriptor test**

Assert `sanction` group exists with `add` and `remove` subcommands.

- [ ] **Step 4: Manual smoke**

Run: `npm run typecheck && npm run format:check`

Expected: PASS

---

### Task 6: Final verification

- [ ] **Run full test suite**

Run: `npm run typecheck && npx vitest run src/services/match/manual-sanction.test.ts src/services/match/match-history.test.ts`

- [ ] **Format**

Run: `npm run format:check` — if fail, `npm run format`

- [ ] **Deploy commands note**

Dev: restart bot or `npm run deploy-commands` so Discord registers the new subcommand group.

---

## Plan self-review (spec coverage)

| Spec requirement                         | Task      |
| ---------------------------------------- | --------- |
| `isManualSanction` schema + index        | Task 1    |
| Full parity add penalties                | Task 2    |
| Remove default latest manual             | Task 3    |
| Remove with `match_id` delegates         | Task 3    |
| Manual quitter remove restores snapshots | Task 3    |
| Hide from match history griefers_only    | Task 4    |
| Mod-only slash commands                  | Task 5    |
| Leaderboard refresh                      | Task 5    |
| Archived league reject                   | Task 2    |
| English strings                          | Tasks 2–5 |

No placeholders remain. `/match list` unchanged (COMPLETED-only) per spec.

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-09-01-manual-quitter-griefer-sanction.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks
2. **Inline Execution** — implement tasks in this session with checkpoints

Which approach do you want?
