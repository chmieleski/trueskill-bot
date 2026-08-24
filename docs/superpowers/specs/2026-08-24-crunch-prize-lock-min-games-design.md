# Crunch prize-lock min games & strict_crunch preset — Design

**Date:** 2026-08-24  
**Status:** Approved for implementation  
**Scope:** `general` (league-scoped crunch prize lock + crunch rate preset; not game-specific)  
**Related:** [`2026-08-23-rating-decay-design.md`](./2026-08-23-rating-decay-design.md), [`2026-08-24-league-decay-config-design.md`](./2026-08-24-league-decay-config-design.md)

## Goal

Let staff apply a **strict crunch** profile in one command and tune medal volume independently:

1. Crunch idle grace **3 days**, then flat **−100 ki/day** (both crunch tiers at 100).
2. 🥇🥈🥉 require **≥ N finished non-quit games** in the **fixed crunch window** (default N = 1; strict preset N = 7 with a 7-day crunch window).

Mid-season decay is **unchanged**.

## Non-goals

- Mid-season presets or mid-season math changes
- Hero rating decay
- Dual prize-lock modes (`daily` attendance vs count) — **count replaces** “game every UTC day of crunch so far”
- Changing code-default crunch rates (still grace 2 / −100 / −200 unless override or preset)
- Auto season end / rollover
- Env / SSM keys
- Retroactive μ changes when settings change

## Locked decisions

| Topic           | Choice                                                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approach        | Count-based prize lock only; default `prizeLockMinGames = 1`                                                                                                                             |
| Window          | Fixed crunch week: `[crunchStart, end]` where `end = min(now, seasonEndsAt)` if `seasonEndsAt` set, else `now`                                                                           |
| Qualifying game | `Match.status = COMPLETED`, `MatchPlayer.isQuitter = false`                                                                                                                              |
| Count           | Total qualifying games in window (not distinct UTC days)                                                                                                                                 |
| Mid-season      | Untouched                                                                                                                                                                                |
| Preset          | `/config decay preset name:strict_crunch`                                                                                                                                                |
| Preset writes   | `decayCrunchGraceDays=3`, `decayCrunchTier1Ki=100`, `decayCrunchTier2Ki=100`, `decayCrunchWindowDays=7`, `decayPrizeLockMinGames=7`; prize lock remains enabled (no write if already on) |
| Preset does not | Toggle `decayEnabled`, set/clear `seasonEndsAt` / `crunchStartedAt`, change mid-season columns                                                                                           |
| Rollover        | Copy new override column like other decay overrides; continue still forces `decayEnabled = false`                                                                                        |

## Data model

### `League`

```prisma
decayPrizeLockMinGames Int?
```

| Value    | Meaning                                                             |
| -------- | ------------------------------------------------------------------- |
| `NULL`   | Default **1** (via `resolveDecaySettings`)                          |
| `1`–`50` | Minimum qualifying games in the crunch window for medal eligibility |

Add to `DECAY_SETTINGS_SELECT`, `DecaySettingsSource`, `ResolvedDecaySettings`, rollover copy lists, and `/config view` decay summary.

### Migration

Additive nullable column only. No backfill required (`NULL` = default 1).

## Prize-lock eligibility

Replace `hasQualifyingActivityEveryUtcDay` / day-set checks with a **count** in the same time range used for the crunch window:

```text
crunchStart = resolveCrunchStart(league)   // existing
windowEnd   = seasonEndsAt != null ? min(now, seasonEndsAt) : now
eligible    = count(qualifying games with completedAt in [crunchStart, windowEnd]) >= prizeLockMinGames
```

When prize lock is off or league is not in crunch, medals follow board rank as today (no eligibility filter).

Leaderboard load path: for overall rows during active prize lock, batch-count qualifying games per player in the window (prefer one query / group-by over N+1). Distinct-UTC-day loading used only for the old rule can be removed or reduced to unused helpers if nothing else needs them.

### Medal assignment

Unchanged walk: ki order → assign 🥇🥈🥉 to the first three `prizeEligible` players. Board `#n` unchanged. `/rank` unchanged.

### Embed / footer copy

Update crunch prize-lock footnote and public/staff wording to:

> Medals need **N** finished (non-quit) games during crunch (N from league settings).

Do not claim “a game every day.”

## Staff commands

Extend `/config decay`:

| Command                                           | Effect                                                   |
| ------------------------------------------------- | -------------------------------------------------------- |
| `/config decay prize_lock_min_games games:<1–50>` | Set override                                             |
| `/config decay clear_prize_lock_min_games`        | Clear override → default 1                               |
| `/config decay preset name:strict_crunch`         | Batch-write strict crunch columns (see locked decisions) |

Existing: `grace` / `tier1_ki` / `tier2_ki` / `tier1_span` / `crunch_window` / `prize_lock` / clears.  
`/config view` shows effective `prizeLockMinGames` next to prize lock on/off.

**Manage Server** (same as other `/config decay` subcommands).

## Defaults vs preset

| Setting                 | Code default | `strict_crunch`                       |
| ----------------------- | ------------ | ------------------------------------- |
| Crunch grace days       | 2            | 3                                     |
| Crunch tier1 / tier2 ki | 100 / 200    | 100 / 100 (flat −100/day after grace) |
| Crunch window days      | 7            | 7                                     |
| Prize lock min games    | 1            | 7                                     |
| Prize lock enabled      | true         | unchanged (still true)                |

## Docs (implementation must update)

| Doc                                                         | Change                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `docs/discord/staff/a7-rating-decay.md`                     | Prize lock = min games in crunch window; document min-games commands + `strict_crunch` recipe     |
| `docs/discord/public/06-rank-and-boards.md`                 | Replace “game on each day of crunch” with volume wording (defaults: ≥1; leagues may require more) |
| `docs/discord/public/07-cheat-sheet.md` / staff cheat sheet | One-line crunch medal rule if present                                                             |
| `2026-08-23-rating-decay-design.md`                         | Note prize lock superseded by count + min games                                                   |
| `2026-08-24-league-decay-config-design.md`                  | Add `prize_lock_min_games` + `preset` rows                                                        |

## Tests

- `isPrizeEligible` / count helper: under / at / over threshold; empty window; prize lock off; not in crunch
- Window end capped by `seasonEndsAt` when set
- Preset writes expected League columns (and does not flip mid-season fields)
- Leaderboard medal assignment with mixed counts
- `resolveDecaySettings` coalesces `NULL` → 1; bounds validation for min games

## Error handling

- Out-of-range min games → ephemeral error (same pattern as other decay bounds)
- Unknown preset name → ephemeral error listing known presets (`strict_crunch` only in v1)
- Archived league → existing writable-league rejection for `/config decay`

## Rollout

1. Migrate column; ship eligibility + commands + preset.
2. Update Discord docs before or with the same release.
3. Staff who want the strict profile run `/config decay preset name:strict_crunch` (and ensure season end / crunch as today).
