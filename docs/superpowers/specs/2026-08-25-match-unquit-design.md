# Match unquit (revert quitters) — Design

**Date:** 2026-08-25  
**Status:** Approved for implementation planning  
**Scope:** `general` (match lifecycle + OpenSkill apply shell; not game-specific)  
**Related:** [`2026-08-15-match-correction-design.md`](./2026-08-15-match-correction-design.md), `/match ungrief` in `match-report.ts`, staff `a2` / `a3`

## Goal

Match moderators (Chmi for now) can clear wrongly marked quitters on **COMPLETED** or **CANCELLED** matches via a single slash command, without running a full flip/void when only the quitter flags need fixing.

## Non-goals

- Host access
- Buttons on the match embed
- Writing rating snapshots on cancel (so cancel-quit penalties can always be undone)
- Replaying later completed matches for the same players
- Confirm / Cancel buttons for v1 (ops-only; same as `ungrief`)
- Changing OpenSkill quitter synthetics, habitual-quitter threshold, or display ki formula
- Adding quitters on finished matches (in-progress `/match quitters` stays the set path)

## Locked decisions

| Topic                 | Choice                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Command               | `/match unquit`                                                                                                                                                                      |
| Auth                  | `assertHasMatchModRole` only (not host)                                                                                                                                              |
| Inputs                | Required `match_id`; optional `slots` (comma-separated). Omit/empty → clear **all** current quitters on the match                                                                    |
| Eligible status       | `COMPLETED` or `CANCELLED`                                                                                                                                                           |
| Rating path           | When match is `COMPLETED` **and** `previewMatchCorrection(matchId).canCorrect` is true → restore snapshots and re-apply with **remaining** quitters and the **current** winning team |
| Flag-only path        | Otherwise (cancelled, outside 24h window, missing snapshots, archived league, etc.) → clear `isQuitter` on target slots only; **do not** change μ/σ                                  |
| Winner on rating path | Derived from current roster (`winningTeamFromPlayers`); never change winner via unquit                                                                                               |
| Remaining quitters    | `currentQuitters − clearedSlots`; may be empty                                                                                                                                       |
| Confirmation          | None in v1                                                                                                                                                                           |
| Newer matches         | On rating path, surface the same newer-match **warning** as flip (ratings overwrite current ki; later matches are not re-applied)                                                    |
| Griefers              | Untouched                                                                                                                                                                            |
| Side effects          | Sync match Discord message; refresh league leaderboard + guild quitter leaderboard                                                                                                   |
| Language              | English user-facing strings                                                                                                                                                          |

## Behavior by match state

| State                                                                    | What happens                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPLETED` + correctable (≤24h, snapshots present, league not archived) | Restore pre-apply ratings → set `isQuitter` / `result` for full roster from remaining quitters + current winner → `applyQuitterPenalties` + `applyMatchRatings` (via existing flip orchestration) |
| `CANCELLED`                                                              | Clear `isQuitter` on targets only; leave ratings                                                                                                                                                  |
| `COMPLETED` but not correctable                                          | Clear `isQuitter` on targets; set their `result` from current winner; leave μ/σ; reply explains ratings were not restored                                                                         |
| `IN_PROGRESS` / `PENDING`                                                | Reject — use `/match quitters` instead                                                                                                                                                            |

## Architecture

```text
/match unquit (thin adapter)
  → assertHasMatchModRole
  → load match (COMPLETED | CANCELLED)
  → clearMatchQuitters(matchId, slots?)
       ├─ resolve target slots (explicit or all isQuitter)
       ├─ remainingQuitters = current quitters − cleared
       ├─ if COMPLETED && previewMatchCorrection.canCorrect:
       │     winningTeam = winningTeamFromPlayers(match)
       │     flipCompletedMatch(matchId, winningTeam, remainingQuitters)
       │     mode = ratings_restored (+ newer-match warn if any)
       └─ else:
             clear isQuitter on targets; if COMPLETED also set result from winner
             mode = flag_only (+ human-readable reason)
  → sync Discord message + refresh boards
  → English reply by mode
```

**Reuse:** `flipCompletedMatch` already restores snapshots and re-applies with an explicit quitter list. Unquit on the rating path is “flip with the same winner and fewer quitters.” Flag-only clearing mirrors `clearMatchGriefers` (no μ/σ writes).

**Placement:** Prefer a dedicated `clearMatchQuitters` in match services (`match-correction` or `match-report`); export from `services/match`; command handler stays thin like `ungrief`.

### Slot resolution

1. If `slots` is provided and non-empty after parse → target = those slots; each must exist on the roster (unknown slot → error).
2. If `slots` omitted or empty → target = every player with `isQuitter === true`; if none, error “no quitters to clear.”
3. Explicit list where **none** of the slots are currently quitters → error “selected slots are not marked as quitters” (same spirit as `clearMatchGriefers`). If some are quitters, clear those; skip non-quitters in the list.

### Rating path details

- Call `previewMatchCorrection` first; only enter restore/re-apply when `canCorrect` is true.
- Pass `remainingQuitters` (not the cleared list) into `flipCompletedMatch`.
- Empty-team guard after removing quitters: same as complete/flip — both teams need ≥1 non-quitter active player. If clearing quitters would leave a team empty of active players, reject with the existing English error (do not fall through to flag-only).
- Snapshots are never rewritten (flip rule unchanged).

### Flag-only details

- Clear `isQuitter` on target slots; do not change μ/σ.
- **COMPLETED:** also set `result` for each cleared player to WIN or LOSS from team vs current winning team (embeds / history stay consistent without a rating restore). Remaining quitters unchanged.
- **CANCELLED:** clear `isQuitter` only; leave `result` as-is (typically null).

## Discord UX

### `/match unquit`

| Option     | Required | Notes                                       |
| ---------- | -------- | ------------------------------------------- |
| `match_id` | yes      | Completed or cancelled match id             |
| `slots`    | no       | Comma-separated; omit to clear all quitters |

### Replies

**Ratings restored:**

```text
Cleared quitter(s) on match `{id}`: slots 2, 8. Ratings were restored and re-applied.
```

If newer matches exist, append the same warning line used by `/match flip`.

**Flag only:**

```text
Cleared quitter(s) on match `{id}`: slots 2, 8. Ratings were not restored ({reason}).
```

Reasons (examples): `match is cancelled`; `outside the 24-hour correction window`; `rating snapshots are missing`; `league is archived`.

## Data model

No schema changes. No new env / SSM keys.

## Testing

- Slot resolution: omit → all quitters; explicit → subset; none / non-quitters → errors
- COMPLETED + `canCorrect` → restore/re-apply with remaining quitters; winner unchanged
- CANCELLED → flag clear only; ratings untouched
- COMPLETED + not correctable → flag clear + `result` fix for cleared slots; ratings untouched
- Empty-team after clear on rating path → reject
- Command registration includes `unquit` subcommand
- Staff docs mention `/match unquit` next to `ungrief`

## Rollout

1. Implement service + `/match unquit` + tests
2. Deploy slash commands so the subcommand appears
3. Update staff Discord docs (`a2`, `a3`, cheat sheet)
4. No migration / infra

## Open questions

None — decisions locked in brainstorming (2026-08-25).
