# New-player rating isolation — Design

**Date:** 2026-08-22  
**Status:** Implemented (partially superseded)  
**Scope:** `general` (OpenSkill apply path, lobby UX; keyed by `leagueId`)  
**Related:** [`2026-08-17-calibrating-ki-display-design.md`](./2026-08-17-calibrating-ki-display-design.md), [`2026-08-18-lobby-relative-rating-scale-design.md`](./2026-08-18-lobby-relative-rating-scale-design.md), `.cursor/rules/openskill-rating.mdc`  
**Supersession:** **When** New seats freeze is redefined by [`2026-08-26-balanced-new-player-isolation-design.md`](./2026-08-26-balanced-new-player-isolation-design.md) (balanced pair-off). Flag, suggest UX, auto-clear, and quit synthetics below remain in force.

## Goal

Maps are hard to learn. Veterans want first-timers in lobbies to grow the playerbase, but high-σ newcomers (and quit-heavy finishes) move ki too hard for both veterans and the newcomers themselves.

**New** players stay in the lobby and play; they are **excluded from team OpenSkill `rate()`** and their μ/σ **freeze** on the non-quit path until the New window ends. Quitter synthetic penalties still apply to New quitters. Veterans’ team updates no longer treat New humans as rating entities.

## Non-goals

- Soft dampening / contribution weights instead of hard exclude
- Per-match-only New marks with no league-scoped flag
- Special rules for calibrating players who are **not** marked New (they rate normally)
- Changing display-ki formula, soft-z, or the calibrating **label** threshold (still `games < 5`)
- Retroactive recalculation of past matches
- Auto-setting New without host/mod confirmation
- Manual toggle beyond the auto-suggest confirm flow (YAGNI for v1; host/mod can decline suggest)

## Locked decisions

| Topic                    | Choice                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Approach                 | Hard exclude + freeze for **paired** New (see 2026-08-26); excess non-quit New rate                                                              |
| When exclude             | **Superseded** — pair-off `k = min(newA, newB)` among non-quit New; see 2026-08-26                                                               |
| New’s own μ/σ (non-quit) | **Freeze** when paired; **rate** when excess (2026-08-26)                                                                                        |
| New + quitter            | Synthetic quit penalty **still applies**; still excluded from team `rate()`                                                                      |
| New ends                 | Auto-clear when completed league games (same count as calibrating / soft-z, including after rank reset) **≥ 5**, even if those games were frozen |
| Unmarked calibrating     | Full OpenSkill participation                                                                                                                     |
| Degenerate lobby         | After removing **frozen** New + quitters, if **either** team has **0** rateable players → **skip team `rate()`**; quit synthetics still run      |
| UX                       | Auto-suggest when a player with **0** completed games joins a PENDING lobby; **host/mod confirms**                                               |
| Decline suggest          | Player remains unmarked → normal rating                                                                                                          |
| Persistence              | `PlayerRating.isNewPlayer` (league-scoped); snapshot `MatchPlayer.wasNewPlayer` at apply time                                                    |
| Rank reset               | Post-reset game count returns to 0 → eligible for suggest again; **do not** auto-set without confirm                                             |
| Equal New counts         | **Restored as pair-off** — see 2026-08-26 (not always-exclude)                                                                                   |
| Language                 | English user-facing strings                                                                                                                      |

## Product note (intentional)

After five frozen completed games, New and Calibrating both clear while μ/σ are still near defaults. **Game 6** is the first real team OpenSkill update. That is the cost of freeze + auto-clear on the same gate.

## Data model

### `PlayerRating`

| Field         | Type      | Default | Meaning                               |
| ------------- | --------- | ------- | ------------------------------------- |
| `isNewPlayer` | `Boolean` | `false` | League-scoped source of truth for New |

Clear `isNewPlayer` to `false` when the player’s completed-game count for that league (since latest `PlayerRankReset`, else lifetime) reaches **≥ 5**. Clearing happens on match completion after that game is counted (same “reveal after match” timing as calibrating ki).

### `MatchPlayer`

| Field          | Type      | Default | Meaning                                                        |
| -------------- | --------- | ------- | -------------------------------------------------------------- |
| `wasNewPlayer` | `Boolean` | `false` | Snapshot of New at rating-apply time (embeds, history, audits) |

Copy from `PlayerRating.isNewPlayer` (or the in-memory decision used for partition) when ratings are applied. Do not recompute later from current flag.

### Migration

Prisma migration adding both booleans with defaults. No backfill required (all existing rows stay `false`).

## Rating apply

Extend the existing partition in `rating-update.ts` (today: quitters vs active).

```text
quitters          = isQuitter
newNonQuit        = wasNewPlayer && !isQuitter
activeRateable    = !isQuitter && !wasNewPlayer
```

### Team Bayesian `rate()`

1. Build dual-entity team arrays from **`activeRateable` only**.
2. If **either** team has zero `activeRateable` humans → **skip** team `rate()` entirely for this match (no μ/σ writes from that path for anyone).
3. Otherwise `rate()` as today, then lobby-relative Δμ scale on those updated humans only.
4. Persist / preview for rateable humans as today.

### New non-quitters

- No μ/σ update (global or hero) from team `rate()` or lobby-relative scale.
- Match still counts as a completed game toward the 5 (W/L recorded on `MatchPlayer` as today).
- Public surfaces may show Calibrating + **New** marker; ki deltas for that player are **0** / omitted consistently with freeze.

### Quitters (including New quitters)

- Remain excluded from team `rate()` (unchanged).
- Run existing N=1 synthetic loss vs peer dummy on league-global + hero (unchanged).
- Quit counts / quitter leaderboard behavior unchanged.

### Griefer

Unchanged: griefer stays in team rating when not a quitter. New + griefer: New exclusion wins (not in team `rate()`); if also quitter, synthetic path only.

### Lobby-relative scale

Average set remains: calibrated active non-quitters (existing rule). New players are calibrating (`games < 5`) so they are already excluded from the average when the fallback is not “whole lobby calibrating.” No separate New rule required beyond “only scale humans who received a team `rate()` update.”

### Predict / balance

`predictWin` / lobby balance hints may still use full roster μ/σ (including New at defaults). Optional follow-up: hide New from balance — **out of scope for v1**.

## UX

### Auto-suggest

**Trigger:** a player with **0** completed league games (post-reset count) is added to a **PENDING** match roster (claim, add-nick link, OCR/import path that creates/links a player — wherever roster membership is committed).

**Audience:** host and match-mod (same authority as report / quitters).

**Prompt:** English ephemeral (or host-facing follow-up): ask to mark the player as New for rating isolation.

**Confirm:** set `PlayerRating.isNewPlayer = true` for that `(leagueId, playerId)`.

**Decline / dismiss:** leave flag false; no re-prompt spam for the same player on the same match (at most one suggest per player per match). Re-joining another lobby later with still 0 games may suggest again.

### Display

- Lobby / in-progress / completed roster lines: show a clear **New** marker when `isNewPlayer` (PENDING) or `wasNewPlayer` (after apply / history).
- Do not invent a second calibrating string; Calibrating label stays as today.

### Permissions

Only host + match-mod role may confirm the suggest. Players cannot self-mark in v1.

## Architecture

```text
PlayerRating.isNewPlayer          // league flag
MatchPlayer.wasNewPlayer          // per-match snapshot

lobby add / link paths
  → maybeSuggestNewPlayer(host/mod)

rating-update.applyMatchRatings
  → partition: quitters | newNonQuit | activeRateable
  → skip team rate if either side empty
  → freeze newNonQuit
  → synthetic quit path (all quitters)
  → clear isNewPlayer when games >= 5 after count
```

Commands and buttons stay thin: confirm handler writes the flag; rating service owns partition math.

## Edge cases

| Case                                      | Rule                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| All humans on one team are New            | Other team rates only if it has ≥1 rateable; if not, skip team `rate()`                                |
| New on both teams, no quitters            | Both sides omit New; remaining veterans rate vs each other                                             |
| Only New (+ quitters) left rateable-empty | Skip team `rate()`; quit synthetics only                                                               |
| Rank reset                                | Flag not auto-set; games=0 → suggest eligible again                                                    |
| Flip / correction re-apply                | Use `wasNewPlayer` snapshot on the match, not live flag, if re-rating from stored roster               |
| Unlinked nick marked New                  | Flag lives on `PlayerRating` once the player row exists; suggest only after a real `playerId` is known |

## Testing (acceptance)

- Unit: partition helpers — New excluded; quitters still synthetic; empty-side skips team `rate()`.
- Unit: freeze — New non-quit μ/σ unchanged after simulate/apply.
- Unit: clear flag when completed games reach 5.
- Unit: lobby-relative scale not applied to frozen New.
- Integration / interaction: suggest fires at 0 games; confirm sets flag; decline leaves false; non-mod cannot confirm.
- Regression: unmarked calibrating player still enters team `rate()` as today.

## Open follow-ups (not v1)

- Host/mod manual toggle after decline
- Exclude New from win-chance / balance display
- Progress copy (`New 2/5`)
