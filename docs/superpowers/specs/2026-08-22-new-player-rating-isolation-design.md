# New-player rating isolation — Design

**Date:** 2026-08-22  
**Status:** Implemented (partially superseded)  
**Scope:** `general` (OpenSkill apply path, lobby UX; keyed by `leagueId`)  
**Related:** [`2026-08-17-calibrating-ki-display-design.md`](./2026-08-17-calibrating-ki-display-design.md), [`2026-08-18-lobby-relative-rating-scale-design.md`](./2026-08-18-lobby-relative-rating-scale-design.md), `.cursor/rules/openskill-rating.mdc`  
**Supersession:** **When** New seats freeze is redefined by [`2026-08-26-balanced-new-player-isolation-design.md`](./2026-08-26-balanced-new-player-isolation-design.md) (balanced pair-off). Flag, suggest UX, auto-clear, and quit synthetics below remain in force.

## Goal

Maps are hard to learn. Veterans want first-timers in lobbies to grow the playerbase, but high-σ newcomers (and quit-heavy finishes) move ki too hard for both veterans and the newcomers themselves.

**New** players stay in the lobby and play. Among non-quit New, **paired** seats freeze out of team OpenSkill `rate()` until the New window ends; **excess** New on the heavier team still rate. See [`2026-08-26-balanced-new-player-isolation-design.md`](./2026-08-26-balanced-new-player-isolation-design.md) for when freeze applies (`k = min(newA, newB)`). Quitter synthetic penalties still apply to New quitters. Veterans’ team updates omit **frozen** New from the rateable set.

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

After five completed games, New and Calibrating both clear while μ/σ may still be near defaults. **Paired** frozen New often accrue games without μ/σ change; **excess** New can receive real team updates earlier. See product note in [`2026-08-26-balanced-new-player-isolation-design.md`](./2026-08-26-balanced-new-player-isolation-design.md).

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

Extend the existing partition in `rating-update.ts` (today: quitters vs active). Pair-off math is defined in [`2026-08-26-balanced-new-player-isolation-design.md`](./2026-08-26-balanced-new-player-isolation-design.md).

```text
quitters       = isQuitter
nonQuitNew     = !isQuitter && wasNewPlayer
k              = min(|nonQuitNew on team 1|, |nonQuitNew on team 2|)
frozenNew      = k lowest-slot nonQuitNew per team
excessNew      = nonQuitNew \ frozenNew
activeRateable = !isQuitter && not in frozenNew
newNonQuit     = frozenNew   // μ/σ freeze path
```

### Team Bayesian `rate()`

1. Build dual-entity team arrays from **`activeRateable` only** (veterans + excess New).
2. If **either** team has zero `activeRateable` humans → **skip** team `rate()` entirely for this match (no μ/σ writes from that path for anyone).
3. Otherwise `rate()` as today, then lobby-relative Δμ scale on those updated humans only.
4. Persist / preview for rateable humans as today.

### New non-quitters

**Frozen** (`newNonQuit` / paired seats):

- No μ/σ update (global or hero) from team `rate()` or lobby-relative scale.
- Match still counts as a completed game toward the 5 (W/L recorded on `MatchPlayer` as today).
- Public surfaces may show Calibrating + **New** marker; ki deltas for that player are **0** / omitted consistently with freeze.

**Excess** (non-quit New beyond `k` on the heavier team): full team `rate()` + lobby-relative scale; may show Calibrating + **New** while `games < 5`. See 2026-08-26.

### Quitters (including New quitters)

- Remain excluded from team `rate()` (unchanged).
- Run existing N=1 synthetic loss vs peer dummy on league-global + hero (unchanged).
- Quit counts / quitter leaderboard behavior unchanged.

### Griefer

Unchanged: griefer stays in team rating when not a quitter. New + griefer (non-quit): if **excess** → rates as griefer (no immediate μ/σ from grief tax; still in team `rate()`); if **frozen** → freeze wins (not in team `rate()`). If also quitter, synthetic path only. See 2026-08-26.

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
  → partition: quitters | frozenNew | excessNew | activeRateable
  → skip team rate if either side empty
  → freeze frozenNew (pair-off k)
  → synthetic quit path (all quitters)
  → clear isNewPlayer when games >= 5 after count
```

Commands and buttons stay thin: confirm handler writes the flag; rating service owns partition math.

## Edge cases

| Case                              | Rule                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| All humans on one team are New    | `k = min(newA,newB)`; excess on heavier side rates; skip team `rate()` only if both sides have 0 `activeRateable` after pair-off (see 2026-08-26) |
| New on both teams, no quitters    | Freeze `k` lowest slots per team; excess + veterans rate vs each other (2026-08-26)                                                               |
| Only frozen New (+ quitters) left | Skip team `rate()`; quit synthetics only                                                                                                          |
| Rank reset                        | Flag not auto-set; games=0 → suggest eligible again                                                                                               |
| Flip / correction re-apply        | Use `wasNewPlayer` snapshot on the match, not live flag, if re-rating from stored roster                                                          |
| Unlinked nick marked New          | Flag lives on `PlayerRating` once the player row exists; suggest only after a real `playerId` is known                                            |

## Testing (acceptance)

- Unit: partition helpers — pair-off `k`, frozen vs excess; quitters still synthetic; empty-side skips team `rate()` (see 2026-08-26).
- Unit: freeze — **frozen** New non-quit μ/σ unchanged after simulate/apply; excess New may move.
- Unit: clear flag when completed games reach 5.
- Unit: lobby-relative scale not applied to frozen New; applied to excess New when rateable.
- Integration / interaction: suggest fires at 0 games; confirm sets flag; decline leaves false; non-mod cannot confirm.
- Regression: unmarked calibrating player still enters team `rate()` as today.

## Open follow-ups (not v1)

- Host/mod manual toggle after decline
- ~~Exclude New from win-chance / balance display~~ — implemented: [`2026-08-28-new-player-balance-mu-discount-design.md`](./2026-08-28-new-player-balance-mu-discount-design.md) (paired omit, excess ~10% μ)
- Progress copy (`New 2/5`)
