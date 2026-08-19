# Calibrating ki display — Design

**Date:** 2026-08-17  
**Status:** Implemented  
**Scope:** `general` (public ki / rank display only; all leagues)

Does **not** change the soft-z formula in [`2026-08-15-soft-early-ki-design.md`](./2026-08-15-soft-early-ki-design.md). Display ki is still computed the same way; this spec only controls when that number is shown and how rank is assigned.

## Goal

Players with fewer than **5** completed league games should not be treated as having a real public rating. Show **Calibrating** instead of ki, omit Rank #, and keep them off the ranked block of leaderboards so early swings do not annoy people.

## Non-goals

- Changing OpenSkill `rate()` / `predictWin` or persisted μ/σ
- Changing the ki formula or `KI_Z_BLEND_GAMES`
- Persisting a calibrating flag or a separate ki column
- Progress copy (`Calibrating 2/5`)
- Hiding win-chance / balance hints (those stay μ/σ)
- Dropping calibrating players from leaderboards entirely
- Per-hero calibration (a new hero after 5 league games shows real hero ki)

## Locked decisions

| Topic             | Choice                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Threshold         | Same count as soft-z: completed WIN/LOSS in that league, **since the latest `PlayerRankReset`** (lifetime if never reset)                          |
| Calibrating       | `games < 5` (`KI_Z_BLEND_GAMES`)                                                                                                                   |
| Public string     | **`Calibrating`** (no progress fraction)                                                                                                           |
| What is hidden    | **All** public ki for that player (global and every hero)                                                                                          |
| Rank #            | Omitted while calibrating                                                                                                                          |
| Leaderboard order | Calibrated first (ki desc, competition ranks). Calibrating appended with **no rank**, sorted by **games desc, then username** — never by hidden ki |
| Rank glyph        | `—` for unranked rows                                                                                                                              |
| Surfaces          | Every place that prints display ki today: `/rank`, overall/live/hero boards, lobby roster lines, post-match roster + deltas                        |
| Reveal            | Use **after-match** game count. The match that reaches 5 shows real ki and deltas                                                                  |
| Eligibility       | Unchanged: overall board still requires ≥1 completed game; hero boards still require `matchesPlayed > 0`                                           |
| OpenSkill         | Unchanged                                                                                                                                          |
| Language          | English user-facing strings                                                                                                                        |

## Display contract

```text
isCalibrating(games)     = games < KI_Z_BLEND_GAMES   // 5
formatPublicKi(ki, games) = "Calibrating" | String(ki)
```

Internal DTOs keep numeric ki for calibrated sort and for reveal-after-5. Formatters (embeds / roster lines) never print the number while `isCalibrating` is true.

Hero ki uses the **player’s league game count**, not `PlayerHeroRating.matchesPlayed`, for this gate.

## Architecture

```text
rating-math.ts
  isCalibrating(games)
  formatPublicKi(ki, games)

leaderboard.ts
  two-tier sort + rank: number | null
  hero rows carry leagueGames for the gate (G column stays matchesPlayed)

player-profile.ts
  rankPosition: number | null
  competition rank among calibrated players only

rank-embed / leaderboard-embed / lobby-preview
  print formatPublicKi; omit Rank # / +delta when calibrating
```

Commands and buttons stay thin. No second copy of the threshold.

### Leaderboard algorithm

1. Load eligible rows as today (≥1 league game overall; `matchesPlayed > 0` for hero).
2. Split: calibrated (`leagueGames ≥ 5`) vs calibrating.
3. Calibrated: sort ki desc, then username. Assign competition ranks (1, 2, 2, 4…).
4. Calibrating: sort **games desc, then username**. `rank = null`.
5. Concatenate: calibrated + calibrating.
6. Paginate / `slice(0, limit)` **after** that order.

Live size N is the first N of this combined list. If there are 8 calibrated and many calibrating, a size-10 live board is 8 ranked + 2 calibrating.

Hero top 3 / top 10 is the same slice. Calibrating names fill remaining slots only when there are not enough calibrated players on that hero.

`assignSortedRanks` stays for the calibrated subset (or a sibling that returns `rank: number | null` for the combined list). Do not rank the concatenated list by hidden ki.

### `/rank`

| State       | Title                                      | Heroes                                       |
| ----------- | ------------------------------------------ | -------------------------------------------- |
| Calibrating | `Calibrating` (no `#`, no number)          | Each row `Name  Calibrating · matchesPlayed` |
| Calibrated  | `Rank #N · {ki} {ratingLabel}` (unchanged) | Real hero ki                                 |

W/L/Q and linked Discord stay. `rankPosition` is `null` while calibrating. Calibrated rank counts **only** other calibrated players (calibrating names do not occupy places).

### Lobby and post-match

Gate on completed WIN/LOSS **already in the ledger**:

- **PENDING / IN_PROGRESS lobby:** current completed count (this match does not count yet).
- **Complete embed:** after-match count (this match’s WIN/LOSS is included).

While that count is below 5:

- Global (and hero, when shown) cells are `Calibrating`.
- Signed `+delta` / `-delta` is omitted.

When the complete embed’s after-match count is ≥ 5, print real ki and deltas, including on the match that just completed calibration.

Win% and balance hints stay numeric.

`/match show` already omits rating preview; no change unless a path prints roster ki — then it uses the same helpers.

## Edge cases

| Case                          | Behavior                                                              |
| ----------------------------- | --------------------------------------------------------------------- |
| 0 completed games             | `/rank` shows `Calibrating`, no `#`. Not on leaderboards              |
| 1–4 games                     | On boards at the bottom: `—` + `Calibrating`                          |
| 5th game completes            | That complete embed shows ki + deltas; player enters the ranked block |
| Rank reset                    | Count restarts → calibrating again                                    |
| Quit LOSS                     | Counts toward the gate once the match is COMPLETED (same as soft-z)   |
| New hero after 5 league games | Real hero ki                                                          |
| ACA / `showHeroes: false`     | Same word on the global rating only                                   |
| Column width                  | `Calibrating` may widen monospace tables                              |
| Ties among calibrated         | Unchanged competition rank                                            |
| Username sort                 | Existing `localeCompare` on stored username                           |

## Testing

- Unit: `isCalibrating` at 0, 4, 5; `formatPublicKi` strings
- Unit: two-tier sort — calibrated ki order and ranks; calibrating after with `null` rank; calibrating order by games then name, **not** hidden ki
- Unit: hero slice uses league games for the gate; `matchesPlayed` still drives the G column / eligibility
- `/rank` embed: calibrating title; calibrated title unchanged; hero cells
- Lobby / complete: hide number and delta while that surface’s count is below 5; show both when the completing match reaches 5
- Existing leaderboard pagination / live chunk tests updated for `rank: number | null` and `—`

## Success criteria

- No public ki number for a player with fewer than 5 completed league games
- No Rank # for those players; they cannot sit in the ranked block
- Hidden ki does not affect visible order among calibrating rows
- At 5 games, ki and rank behave as they do today (soft-z included)
- `rate()` / win% / μ/σ persistence unchanged
- One threshold: `KI_Z_BLEND_GAMES` via `isCalibrating`

## Out of scope / follow-ups

- Update `.cursor/rules/openskill-rating.mdc` when implementing (public ki still formula-based; add the calibrating display gate)
- Optional later: progress `N/5` copy (explicitly rejected for v1)
