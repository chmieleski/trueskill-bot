# Match correction (flip winner / void) — Design

**Date:** 2026-08-15  
**Status:** Approved for implementation planning  
**Scope:** `general` (match status + OpenSkill apply shell; not game-specific)

## Goal

Match moderators can fix a wrongly reported **completed** match within **24 hours**:

1. **`/match flip`** — set the correct winning team and optionally change quitters; restore pre-apply ratings and re-apply OpenSkill for that match.
2. **`/match void`** — undo the completion so the match no longer counts; restore pre-apply ratings and mark the match cancelled.

## Non-goals

- Host access (correction is **mod role only**)
- Buttons on the completed-match embed (slash + confirm only for v1)
- Recalculating later completed matches for the same players
- Correcting matches that never reached `COMPLETED` (in-progress cancel remains `/match cancel`)
- Approximate “flip from current μ/σ” without restore
- Public slash to list correction history (optional structured logs are fine)
- Changing OpenSkill defaults or display ki formula

## Locked decisions

| Topic | Choice |
|-------|--------|
| Commands | `/match flip` and `/match void`; both require `match_id` |
| Auth | `assertHasMatchModRole` only (not host) |
| Flip inputs | Required `winner` (A/B); optional `quitters` (omit → keep current flags) |
| Void effect | Restore snapshots → clear `result` / `isQuitter` → `status = CANCELLED` → refresh Discord embed |
| Window | Allowed only if `now - Match.completedAt ≤ 24 hours` |
| Later games | Always allow within window; **warn** on confirm if any roster player has a newer `COMPLETED` match in the same league |
| Rating approach | Pre-apply μ/σ (+ hero `matchesPlayed`) **snapshots** written in `completeMatch` before rating writes |
| Pre-feature / missing snapshots | Reject with a clear English error |
| Snapshot lifecycle | Written once on first complete; never replaced by flip |
| Confirmation | Ephemeral Confirm / Cancel (same pattern as rank reset / match cancel) |
| `completedAt` | Set once when first transitioning to `COMPLETED`; **not** bumped on flip; null or >24h → not correctable |

## Architecture

```text
/match flip|void (thin adapters)
  → assertHasMatchModRole
  → load COMPLETED match + snapshots
  → assertCorrectable (status, completedAt ≤ 24h, snapshots present)
  → detectNewerCompletedMatches (warn only)
  → ephemeral confirm
  → on Confirm:
       flip: restoreSnapshots → write flags/results → applyQuitterPenalties + applyMatchRatings
       void: restoreSnapshots → clear results/quitters → CANCELLED
  → sync Discord message + refresh league leaderboard
```

Rating math stays in `rating-update` / existing apply helpers. Correction orchestration lives in match services (extend `match-report` or a sibling `match-correction` module — keep Discord I/O thin).

### Snapshot write path

Inside `completeMatch`, **before** `applyQuitterPenalties` / `applyMatchRatings`:

- For each roster `MatchPlayer`, persist:
  - League-global: `mu`, `sigma` for `(leagueId, playerId)`
  - Hero: `mu`, `sigma`, `matchesPlayed` for `(leagueId, playerId, heroId)`

Cancel-with-quitters on `IN_PROGRESS` does **not** need snapshots for this feature (void/flip only target `COMPLETED`).

Snapshots are written **once** on the first successful complete. Flip must **not** replace them (they remain the true pre-first-apply baseline for any later flip/void in the window).

### Restore

In one transaction:

1. Lock match; re-check `COMPLETED`, window (`completedAt` present and ≤ 24h), snapshots complete.
2. Write stored μ/σ (and hero `matchesPlayed`) back onto current rating rows.
3. **Flip:** resolve quitters (new list or existing) → same empty-team guard as complete → update `MatchPlayer` flags/results → `applyQuitterPenalties` + `applyMatchRatings` → keep `COMPLETED` → **always** sync the channel completed embed (new winner / roster / ki).
4. **Void:** set all `MatchPlayer.result = null`, `isQuitter = false` → `status = CANCELLED` → cancelled embed. Do **not** delete snapshot rows (audit of what was restored); do not re-apply ratings.

Global display game-count (completed W/L) follows `MatchPlayer.result` on `COMPLETED` matches — voiding clears results so those games no longer count. Hero `matchesPlayed` is restored from the snapshot then re-incremented only on flip re-apply for non-quitters.

## Data model

### `Match.completedAt`

```prisma
completedAt DateTime?
```

- Set when status first becomes `COMPLETED`.
- Unchanged on flip.
- Left as-is on void (historical “when it was completed”); eligibility for correction still requires `status === COMPLETED`, so voided matches are not re-correctable.

### `MatchRatingSnapshot`

One row per rating entity touched by the match apply. Use an explicit kind so Postgres uniqueness is clean:

| Field | Notes |
|-------|--------|
| `id` | cuid |
| `matchId` | FK → Match, cascade delete |
| `playerId` | FK → Player |
| `entityKind` | `GLOBAL` \| `HERO` |
| `heroId` | Required when `HERO`; unused/`0` or omitted when `GLOBAL` (implementation picks one convention and sticks to it) |
| `mu` / `sigma` | Pre-apply values |
| `matchesPlayed` | Pre-apply hero count; unused/null for `GLOBAL` |
| `createdAt` | When snapshot was written |

Constraints:

- Unique per entity, e.g. `@@unique([matchId, playerId, entityKind, heroId])` with a fixed `heroId` sentinel for `GLOBAL` rows, **or** two partial unique indexes — pick one in the migration and document it in the plan.
- Index on `matchId`.

Exactly one snapshot set per completed match that used the new path. Correction requires a full set: for every roster player, one `GLOBAL` row and one `HERO` row for that slot’s `heroId`.

## Discord UX

### `/match flip`

| Option | Required | Notes |
|--------|----------|--------|
| `match_id` | yes | Completed match id |
| `winner` | yes | A / B (team display names in choices) |
| `quitters` | no | Comma-separated slots; omit keeps current flags |

Flow: defer ephemeral → validate → confirm summary (winner, quitters, 24h remaining optional, later-match warning if any) → Confirm runs correction → success reply; sync channel embed.

### `/match void`

| Option | Required | Notes |
|--------|----------|--------|
| `match_id` | yes | Completed match id |

Same confirm pattern; success → cancelled embed in channel.

### Auth resolve

Unlike `/match complete`, do **not** treat host as authorized. Resolve guild config → `assertHasMatchModRole`. `match_id` is always required (mods are rarely the host of the target match).

### Confirm buttons

Bind `matchId`, actor Discord id, and action payload (flip: winner + quitters encoding; void: action only). Reject clicks from other users. Re-run eligibility at confirm time (window may have expired).

## Edge cases

| Case | Behavior |
|------|----------|
| Unauthorized / mod role unset | Existing mod-role errors |
| Not `COMPLETED` | Reject |
| `completedAt` null or older than 24h | Reject |
| Snapshots missing or incomplete | Reject |
| Flip leaves a team with zero non-quitters | Reject (same message family as complete) |
| Concurrent double-confirm | Row lock + status check; second fails |
| After void | Not correctable again |
| Later completed matches exist | Warn on confirm; still proceed |
| Leaderboard | Refresh after successful flip/void (same hook pattern as complete) |

## Error copy (English)

Examples (exact strings may be refined in implementation):

- `Only match moderators can do that.` / mod role not configured (existing)
- `This match is not completed.`
- `This match can only be corrected within 24 hours of completion.`
- `This match cannot be corrected because rating snapshots are missing.`
- Empty-team-after-quitters: reuse complete’s message
- Later-match warning (confirm body, not a hard error): e.g. some players have played ranked matches since this one; those results will not be recalculated

## Testing

- Snapshot written on complete for global + hero entities (μ/σ/`matchesPlayed`)
- Flip: restore then opposite winner changes results and ratings vs wrong baseline without restore
- Flip with changed quitters: penalties + exclusions match new set
- Void: ratings restored to snapshot; results cleared; status `CANCELLED`
- Reject: >24h, missing snapshots, not completed, non-mod, empty team after quitters
- Later-match detection returns true/false for warning path
- Confirm after window expires → reject

## Docs

- Staff: `docs/discord/staff/a2-mod-powers.md`, `a5-admin-cheat-sheet.md`
- Public: brief note in play/finish guide that wrong reports should be flagged to mods (no public flip/void)

## Migration / rollout

1. Prisma migration: `Match.completedAt` + snapshot table.
2. Backfill: leave `completedAt` null and no snapshots for old rows → not correctable (by design).
3. Deploy bot + slash command update (`flip` / `void` subcommands).
4. New completions start writing `completedAt` + snapshots.

## Deferred

- Correction buttons on completed embeds
- Recalculating a chain of later matches
- Staff audit table / slash listing of flips and voids
- Extending the 24h window via guild/league config
