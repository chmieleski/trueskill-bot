# Match Report (End Match / Winner / Quitters / Cancel) — Design

**Date:** 2026-08-13  
**Status:** Approved for implementation planning  
**Scope:** Host/mod flows to report results on `IN_PROGRESS` matches: set quitters, complete with winner (OpenSkill `rate()`), or cancel (void or quit-penalties)

## Goal

After a match is started, authorized users can:

1. **Mark quitters** (flags only; match stays in progress)
2. **Report winner** (optional quitters → winning team → confirm → complete + update ratings)
3. **Cancel** the in-progress match (void, or apply quitter penalties if any were flagged)

Primary UX is **buttons on the Match In Progress embed**. Slash commands mirror the same use-cases.

## Non-goals

- Draws (`MatchResult.DRAW` unused)
- Result disputes / undo after complete
- Leaderboards
- Auto-detect quitters from Warcraft III
- Changing PENDING lobby cancel behavior (already exists)
- Showing ordinal deltas on the completed embed (v1 shows final ordinals only)

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Outcome model | Quitters flag path + complete with winner + cancel |
| Auth | Host **or** member with Discord role from `MATCH_MOD_ROLE_ID` |
| Mod role config | Single env role ID (empty/unset → host-only) |
| Primary UI | Three buttons: Report Winner, Quitters, Cancel |
| Slash | Mirrors via shared use-cases (`/match` subcommands) |
| Architecture | Ephemeral wizard + `match-report` / `rating-update` services |
| Report Winner steps | Quitters (pre-select existing flags) → Winner → Confirm |
| Quitters button | Persist `isQuitter` only; no rating writes; stay `IN_PROGRESS` |
| Quitter penalty | N=3 synthetic OpenSkill losses vs strong dummy team (global + hero) |
| Cancel + quitters | Apply quitter penalties, then `CANCELLED`; plain cancel voids ratings |
| Complete + quitters | Penalties first; Bayesian `rate()` excludes quitters |
| Empty team after excluding quitters | Reject complete; host must Cancel |
| Completed embed | Winner + roster/ordinals + 🚪 quitters; no buttons; no delta lines |

## Architecture

```text
Buttons / slash (thin adapters)
  → assertCanManageMatch(host | MATCH_MOD_ROLE_ID)
  → match-report use-cases
       setQuitters(matchId, slots[])
       completeMatch(matchId, winningTeam, quitterSlots[])
       cancelInProgressMatch(matchId)
  → rating-update
       applyQuitterPenalties(...)   // N=3 synthetic losses
       applyMatchRatings(...)       // rate(); quitters excluded
  → persist MatchPlayer + Match.status (single transaction)
  → sync Discord message (completed / cancelled / in-progress refresh)
```

### New modules

- `src/services/match-report.ts` — status/auth orchestration, roster flag/result writes, Discord sync hooks
- `src/services/rating-update.ts` — OpenSkill `rate()` for match outcome + quitter synthetic losses; dual-entity team building shared/reused with rating-preview helpers where practical

Rating math stays out of command/button handlers.

### Env

| Var | Purpose |
|-----|---------|
| `MATCH_MOD_ROLE_ID` | Optional Discord role ID; holders may report/cancel like the host |

Document in `.cursor/rules/scripts-and-env.mdc` and `src/config/env.ts`.

### Schema

No Prisma migration. Existing fields/enums suffice:

- `Match.status`: `IN_PROGRESS` → `COMPLETED` | `CANCELLED`
- `MatchPlayer.result`: `WIN` | `LOSS` (null until complete; stays null on cancel)
- `MatchPlayer.isQuitter`

## Discord UX

### Match In Progress buttons

| Button | Style | Behavior |
|--------|--------|----------|
| Report Winner | Success | Ephemeral wizard |
| Quitters | Danger | Ephemeral multi-select → `setQuitters` → refresh embed |
| Cancel | Secondary | Confirm → `cancelInProgressMatch` |

### Report Winner (ephemeral)

1. Multi-select quitters — pre-select slots already `isQuitter`; Skip allowed  
2. Winner — Team A / Team B  
3. Confirm summary → `completeMatch` → channel **Match Completed** embed (no buttons)

### Quitters button

- Multi-select players; persist flags; embed roster shows 🚪 on quitters  
- Does **not** apply rating penalties  
- Match remains `IN_PROGRESS`

### Cancel

- Confirm step  
- If any `isQuitter`: apply N=3 synthetic penalties to those players, then `CANCELLED`  
- If none: `CANCELLED` only, no rating writes  
- Channel embed → Match Cancelled (host/mod cancel reason)

### Slash mirrors

Shared use-cases, e.g.:

- `/match quitters`
- `/match complete`
- `/match cancel`

Resolve target match like existing `/lobby` (`match_id` when host has multiple, or message-context where applicable). Auth identical to buttons.

## Rating rules

### Dual entity graph

Unchanged: each human contributes `[global, hero]` to team arrays. Empty slots absent.

### Quitter penalties

For each quitter, treat their ratings as a dual-entity team `[PlayerRating, PlayerHeroRating]` and run OpenSkill `rate()` **3** times against a fixed strong dummy team (constants in `rating-update.ts`, not in DB). Quitter loses each iteration. Persist updated μ/σ for global and hero.

### Match Bayesian update (complete only)

1. Apply quitter penalties for selected quitters  
2. Build dual-entity arrays for **non-quitters only**  
3. `rate([winners, losers])` with winner rank 1 / loser rank 2  
4. Persist μ/σ; increment `PlayerHeroRating.matchesPlayed` for non-quitters who played

Quitters receive `result = LOSS` and `isQuitter = true`; they do **not** participate in step 3.

### Cancel with quitters

Apply quitter penalties only. Do not set `WIN`/`LOSS`. Do not call match `rate()`.

## Persistence contract

### `setQuitters`

- Require `IN_PROGRESS`  
- Set `isQuitter` true for selected slots, false for others (full replace of flags)  
- No status change  

### `completeMatch`

- Require `IN_PROGRESS`  
- After excluding quitters, both teams must have ≥1 player — else reject  
- Transaction: write flags + results + rating updates + `status = COMPLETED`  
- Sync completed embed  

### `cancelInProgressMatch`

- Require `IN_PROGRESS` (PENDING cancel remains existing lobby cancel path)  
- Transaction: optional quitter penalties + `status = CANCELLED`  
- Sync cancelled embed  

## Edge cases

| Case | Behavior |
|------|----------|
| Unauthorized user | Ephemeral reject |
| Not `IN_PROGRESS` | Reject |
| Complete with empty team after quitters | Reject; suggest Cancel |
| Wizard Discord expiry | Re-open Report Winner; prior Quitters flags still pre-select |
| Concurrent double-complete | Status check inside transaction; second fails |
| `MATCH_MOD_ROLE_ID` unset | Host-only |
| Rating/DB failure | Single transaction — no partial COMPLETED without ratings |

## Testing

Vitest unit tests (extend existing setup):

- Quitter synthetic loss lowers μ over N=3  
- Match `rate()` team arrays exclude quitters  
- Complete rejected when a side has zero non-quitters  
- Cancel with quitters applies penalties; cancel without does not  

No Discord integration tests for this feature.

## Spec self-review

- No TBD/TODO placeholders  
- Cancel + quitters vs complete + quitters behaviors are distinct and consistent with locked decisions  
- Scope is match report only (no leaderboards / draws / undo)  
- Empty-team-after-quitters rule is explicit  

## Out of scope (explicit)

- Calling `rate()` from lobby preview  
- Changing OpenSkill defaults (μ 25 / σ 8.333)  
- Auto cleanup of stale `IN_PROGRESS` matches (follow-up if needed)
