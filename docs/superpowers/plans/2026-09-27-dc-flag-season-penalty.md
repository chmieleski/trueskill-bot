# DC flag + season disconnect penalty — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add league-scoped `MatchPlayer.isDc`, mark/clear it like griefer (in-match + sanction), show counts on `/rank` and `dcs_only` history, and apply `floor(dcCount / 3) * 300` ki tax at season rollover.

**Architecture:** Boolean flag on `MatchPlayer` (no accrued column). Tax helpers mirror griefer season tax but derive ki from incident count. Report/cancel, slash commands, manual sanctions, display stats, and league rollover all thread `isDc` with quitter winning over DC and DC stacking with griefer.

**Tech Stack:** Node.js ESM, TypeScript, discord.js v14, Prisma/PostgreSQL, Vitest, pnpm monorepo (`@dbz/bot`, `@dbz/db`).

## Global Constraints

- Scope: `general` — league-scoped; no game-specific imports.
- User-facing strings: English only.
- Tax: `floor(dcCount / 3) * 300` on ending-season global μ at `/league rollover`.
- Quitter clears DC; DC may stack with griefer; DC stays in team `rate()`.
- No live DC leaderboard.
- Manual sanctions hidden from match history (incl. `dcs_only`).
- ESM `.js` imports; Conventional Commits; `pnpm format:check` before PR.
- Paths below are relative to repo root; bot code lives under `apps/bot/`, schema under `packages/db/`.

---

## File map

| File                                                               | Responsibility                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| `packages/db/prisma/schema.prisma`                                 | `MatchPlayer.isDc`                                           |
| `packages/db/prisma/migrations/…`                                  | Migration SQL                                                |
| `apps/bot/src/services/rating/dc-tax.ts`                           | Threshold constants + `computeDcSeasonTaxKi` + count→tax map |
| `apps/bot/src/services/rating/dc-tax.test.ts`                      | Pure unit tests                                              |
| `apps/bot/src/services/rating/rank-reset-display.ts`               | `dcs` on display stats + pending DC tax loader               |
| `apps/bot/src/services/match/match-report.ts`                      | `setDcs`, `clearMatchDcs`, persist on complete/cancel        |
| `apps/bot/src/services/match/manual-sanction.ts`                   | Extend type `dc`                                             |
| `apps/bot/src/services/match/match-history.ts`                     | `dcsOnly` filter                                             |
| `apps/bot/src/services/player/player-profile.ts`                   | `/rank` DCs + pending tax                                    |
| `apps/bot/src/services/lobby/lobby-preview.ts`                     | ` 🔌` mark                                                   |
| `apps/bot/src/services/league/league-rollover.ts`                  | Apply DC tax with griefer tax                                |
| `apps/bot/src/commands/match/match.ts`                             | `dcs` / `undc` / sanction / history / complete / cancel      |
| `apps/bot/src/discord/interactions/match-interactions.ts`          | In-match DC toggles                                          |
| `apps/bot/src/discord/interactions/match-approval-interactions.ts` | Approval DC slots                                            |
| `.cursor/rules/openskill-rating.mdc`                               | Document DC edge case                                        |

---

### Task 1: Schema — `isDc`

**Files:**

- Modify: `packages/db/prisma/schema.prisma`
- Create: migration via `pnpm db:migrate`

**Interfaces:**

- Produces: `MatchPlayer.isDc Boolean @default(false)`

- [ ] **Step 1: Add field** after `isGriefer`:

```prisma
  isDc Boolean @default(false) // Disconnect incident; season tax from count
```

- [ ] **Step 2: Migrate**

Run: `pnpm db:migrate -- --name add_match_player_is_dc`

Expected: SQL `ALTER TABLE "MatchPlayer" ADD COLUMN "isDc" BOOLEAN NOT NULL DEFAULT false;`

- [ ] **Step 3: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "$(cat <<'EOF'
feat(db): add MatchPlayer.isDc flag

EOF
)"
```

---

### Task 2: DC tax pure helpers

**Files:**

- Create: `apps/bot/src/services/rating/dc-tax.ts`
- Create: `apps/bot/src/services/rating/dc-tax.test.ts`

**Interfaces:**

- Produces:

```typescript
export const DC_PENALTY_THRESHOLD = 3;
export const DC_PENALTY_KI = 300;
export function computeDcSeasonTaxKi(dcCount: number): number;
export function sumDcSeasonTaxByPlayer(rows: Array<{ playerId: string }>): Map<string, number>;
export function summarizeDcSeasonTax(taxByPlayer: Map<string, number>): {
  playerCount: number;
  totalKiTax: number;
};
```

- [ ] **Step 1: Failing tests** in `dc-tax.test.ts` covering 0→0, 2→0, 3→300, 5→300, 6→600; sum by player; summarize.

- [ ] **Step 2: Implement** `dc-tax.ts` using `computeDcSeasonTaxKi = Math.floor(Math.max(0, dcCount) / 3) * 300`; `sumDcSeasonTaxByPlayer` counts rows per player then maps through compute; reuse shape of `summarizeGrieferSeasonTax`.

- [ ] **Step 3: Run** `pnpm --filter @dbz/bot exec vitest run src/services/rating/dc-tax.test.ts` — PASS

- [ ] **Step 4: Commit** `feat(rating): add DC season tax helpers`

---

### Task 3: Display stats — `dcs` + pending tax loader

**Files:**

- Modify: `apps/bot/src/services/rating/rank-reset-display.ts`
- Modify: `apps/bot/src/services/rating/rank-reset-display.test.ts`

**Interfaces:**

- Extend `PlayerMatchDisplayStats` with `dcs: number`
- Aggregate: when `row.isDc && !row.isQuitter` after rank-reset cutoff, `bucket.dcs += 1`
- Add `loadPendingDcTaxByPlayer(leagueId, playerIds?)` counting full-league `isDc && !isQuitter` → `sumDcSeasonTaxByPlayer`

- [ ] **Step 1:** Extend row type / queries to select `isDc`; update aggregate + empty buckets (`dcs: 0`).

- [ ] **Step 2:** Tests for DC count with rank-reset cutoff and pending tax ignoring reset.

- [ ] **Step 3: Commit** `feat(rating): count DCs in display stats`

---

### Task 4: Match report — `setDcs` / `clearMatchDcs` / persist

**Files:**

- Modify: `apps/bot/src/services/match/match-report.ts`
- Modify: `apps/bot/src/services/match/match-report.test.ts`
- Modify: `apps/bot/src/services/match/index.ts` (re-exports)

**Interfaces:**

```typescript
export async function setDcs(matchId: string, dcSlots: number[]): Promise<MatchWithPlayers>;
export async function clearMatchDcs(
  matchId: string,
  slots?: number[],
): Promise<{ match: MatchWithPlayers; cleared: Array<{ slot: number; playerId: string }> }>;
```

- [ ] **Step 1:** `setQuitters` also sets `isDc: false` when quitter; `setGriefers` must **not** clear `isDc`; add `setDcs` that sets `isDc` and clears `isQuitter` when DC (keep griefer).

- [ ] **Step 2:** Thread `dcSlots` through `completeMatch` / `cancelMatch` / `toRatingEntries` / mitigation paths — persist `isDc`; quitter forces `isDc: false`.

- [ ] **Step 3:** `clearMatchDcs` mirror `clearMatchGriefers` without ki fields.

- [ ] **Step 4:** Tests for flag interactions + clear.

- [ ] **Step 5: Commit** `feat(match): set and clear DC flags`

---

### Task 5: Manual sanction `dc`

**Files:**

- Modify: `apps/bot/src/services/match/manual-sanction.ts`
- Modify: `apps/bot/src/services/match/manual-sanction.test.ts`

**Interfaces:**

- `ManualSanctionType = 'quitter' | 'griefer' | 'dc'`
- Add: create match with `isDc: true` only; no ratings/accrual
- Remove: `clearMatchDcs`; find latest where `isDc && !isQuitter`

- [ ] **Step 1–3:** Extend types, add/remove flows, tests, commit `feat(match): manual DC sanctions`

---

### Task 6: Match history `dcs_only`

**Files:**

- Modify: `apps/bot/src/services/match/match-history.ts` (+ test)

- [ ] Filter `players: { some: { playerId, isDc: true, isQuitter: false } }`, exclude `isManualSanction`, customId suffix `:d` parallel to `:g`.

- [ ] Commit `feat(match): history dcs_only filter`

---

### Task 7: `/rank`, lobby mark, openskill rule

**Files:**

- Modify: `apps/bot/src/services/player/player-profile.ts` (+ embed builder if separate)
- Modify: `apps/bot/src/services/lobby/lobby-preview.ts`
- Modify: `.cursor/rules/openskill-rating.mdc`

- [ ] Profile: `dcs`, `pendingDcSeasonTax`; show on rank embed.
- [ ] Lobby: ` 🔌` when `isDc && !isQuitter`.
- [ ] Doc DC edge case in openskill rule.
- [ ] Commit `feat(rank): show DC count and pending season tax`

---

### Task 8: League rollover DC tax

**Files:**

- Modify: `apps/bot/src/services/league/league-rollover.ts`
- Modify: `apps/bot/src/services/league/league-rollover.test.ts`
- Modify: command/preview strings that mention griefer season tax

- [ ] `loadPendingDcTaxForLeague` → apply with `applyGrieferSeasonTaxToSeededGlobals` (same μ helper) after or combined with griefer tax on ending globals.
- [ ] Preview includes DC season tax line.
- [ ] Commit `feat(league): apply DC season tax on rollover`

---

### Task 9: Slash commands + Discord interactions

**Files:**

- Modify: `apps/bot/src/commands/match/match.ts` (+ `match.test.ts`)
- Modify: `apps/bot/src/discord/interactions/match-interactions.ts`
- Modify: `apps/bot/src/discord/interactions/match-approval-interactions.ts`
- Modify: `apps/bot/src/services/match/match-mitigation-approval.ts` if it copies griefer slots

- [ ] Add `dcs` / `undc` subcommands; sanction choices `DC`; complete/cancel `dcs` option; history `dcs_only`.
- [ ] Wire UI toggles parallel to griefers.
- [ ] Commit `feat(match): DC slash commands and report UI`

---

### Task 10: Format + typecheck

- [ ] `pnpm --filter @dbz/bot exec vitest run` on touched tests
- [ ] `pnpm typecheck`
- [ ] `pnpm format:check` (or `pnpm format`)
- [ ] Final commit if format fixes needed

---

## Spec coverage check

| Spec item                     | Task                         |
| ----------------------------- | ---------------------------- |
| `isDc` column                 | 1                            |
| Tax formula                   | 2, 8                         |
| set/clear + quit/grief matrix | 4                            |
| Manual sanction               | 5                            |
| History `dcs_only`            | 6                            |
| `/rank` + lobby               | 7                            |
| Rollover                      | 8                            |
| In-match + slash              | 9                            |
| No live board                 | (explicit non-goal; no task) |
