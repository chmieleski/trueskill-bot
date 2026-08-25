# Match unquit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/match unquit` so mods can clear quitters on COMPLETED/CANCELLED matches, restoring ratings when the match is still correctable.

**Architecture:** `clearMatchQuitters` in `match-report.ts` (alongside `clearMatchGriefers`) calls `previewMatchCorrection` + `flipCompletedMatch` for the rating path, or clears flags (+ COMPLETED `result`) for flag-only. Thin command adapter mirrors `ungrief`.

**Tech Stack:** TypeScript, Vitest, discord.js SlashCommandBuilder, Prisma

**Spec:** `docs/superpowers/specs/2026-08-25-match-unquit-design.md`

## Global Constraints

- Scope: `general`
- English user-facing strings only
- Mod role only (`assertHasMatchModRole`)
- No schema / env / SSM changes
- Conventional Commits

## File map

| File                                            | Role                                 |
| ----------------------------------------------- | ------------------------------------ |
| `src/services/match/match-report.ts`            | `clearMatchQuitters`                 |
| `src/services/match/match-report.test.ts`       | Unit tests                           |
| `src/services/match/index.ts`                   | Re-export                            |
| `src/commands/match/match.ts`                   | `/match unquit` subcommand + handler |
| `src/commands/match/match.test.ts`              | Registration assertion               |
| `docs/discord/staff/a2-mod-powers.md`           | Staff docs                           |
| `docs/discord/staff/a3-quitters-and-ratings.md` | Staff docs                           |
| `docs/discord/staff/a5-admin-cheat-sheet.md`    | Cheat sheet                          |

---

### Task 1: `clearMatchQuitters` service + tests

**Files:**

- Modify: `src/services/match/match-report.ts`
- Modify: `src/services/match/match-report.test.ts`
- Modify: `src/services/match/index.ts`

**Interfaces:**

- Produces:

  ```ts
  export type ClearedMatchQuitter = { slot: number; playerId: string };
  export type ClearMatchQuittersResult = {
    match: MatchWithPlayers;
    cleared: ClearedMatchQuitter[];
    mode: 'ratings_restored' | 'flag_only';
    flagOnlyReason?: string;
    hasNewerMatches?: boolean;
    ratingPreview?: LobbyRatingPreview;
  };
  export async function clearMatchQuitters(
    matchId: string,
    slots?: number[],
  ): Promise<ClearMatchQuittersResult>;
  ```

- [ ] **Step 1: Write failing tests** in `match-report.test.ts`

Cover:

1. Omit slots → clears all quitters (flag-only CANCELLED path)
2. Explicit slots → subset; skips non-quitters if at least one quitter cleared
3. Reject IN_PROGRESS / PENDING
4. Reject when no quitters
5. Reject unknown slots
6. Reject when explicit slots are all non-quitters
7. COMPLETED + canCorrect → calls flip with remaining quitters + current winner (`mode: ratings_restored`)
8. COMPLETED + not correctable → flag clear + set `result` from winner (`mode: flag_only`)

Mock `previewMatchCorrection` / `flipCompletedMatch` via `vi.mock('./match-correction.js', …)` extending existing mocks carefully (match-report already imports `writeMatchRatingSnapshots` from match-correction — mock that module and re-export needed pieces).

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npx vitest run src/services/match/match-report.test.ts
```

- [ ] **Step 3: Implement `clearMatchQuitters`**

Logic per spec:

1. Load match; require COMPLETED | CANCELLED
2. Resolve target slots (omit → all quitters; explicit → assert known; none marked quitter → error)
3. `remainingQuitters` = current quitters not in target
4. If COMPLETED && `preview.canCorrect`: `winningTeamFromPlayers` → `flipCompletedMatch(id, winner, remainingQuitters)` → return ratings_restored (+ `hasNewerMatches` from preview)
5. Else flag-only transaction: for each cleared quitter, `isQuitter: false`; if COMPLETED also set `result` WIN/LOSS from team vs `winningTeamFromPlayers`; reason from `preview.correctionBlockReason` or status (`match is cancelled`)

Import `winningTeamFromPlayers` from `match-history.js` (or inline team check to avoid cycles — prefer history helper).

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Export from `index.ts`**

- [ ] **Step 6: Commit** `feat(match): add clearMatchQuitters service`

---

### Task 2: `/match unquit` command + registration test

**Files:**

- Modify: `src/commands/match/match.ts`
- Modify: `src/commands/match/match.test.ts`

- [ ] **Step 1: Extend registration test** to expect `unquit` after `ungrief`

- [ ] **Step 2: Add subcommand** mirroring `ungrief` (`match_id`, optional `slots`)

- [ ] **Step 3: Handler** — reuse finished-match mod resolve (generalize `resolveFinishedMatchForModGrieferClear` → `resolveFinishedMatchForModClear` or duplicate for quitters); call `clearMatchQuitters`; sync Discord message (`completed` | `cancelled`); refresh league + `refreshGuildQuitterLeaderboard`; format reply from mode

- [ ] **Step 4: Run** `npx vitest run src/commands/match/match.test.ts src/services/match/match-report.test.ts`

- [ ] **Step 5: Commit** `feat(match): add /match unquit command`

---

### Task 3: Staff docs

**Files:**

- Modify: `docs/discord/staff/a2-mod-powers.md`
- Modify: `docs/discord/staff/a3-quitters-and-ratings.md`
- Modify: `docs/discord/staff/a5-admin-cheat-sheet.md`

- [ ] **Step 1: Add one-liners** for `/match unquit` next to `ungrief`

- [ ] **Step 2: Commit** `docs(discord): document /match unquit`

- [ ] **Step 3: Format check** `npm run format:check`

---

## Spec coverage checklist

| Spec item                             | Task |
| ------------------------------------- | ---- |
| `/match unquit` mod-only              | 2    |
| Optional slots / clear all            | 1    |
| Rating path via flip                  | 1    |
| Flag-only CANCELLED / not correctable | 1    |
| COMPLETED flag-only updates `result`  | 1    |
| Newer-match warning                   | 2    |
| Board refresh                         | 2    |
| Staff docs                            | 3    |
| No schema                             | —    |
