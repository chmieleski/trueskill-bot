# Balanced New-player isolation — Design

**Date:** 2026-08-26  
**Status:** Implemented (on branch)  
**Scope:** `general` (OpenSkill apply partition; keyed by `leagueId`)  
**Supersedes (partial):** [`2026-08-22-new-player-rating-isolation-design.md`](./2026-08-22-new-player-rating-isolation-design.md) — **when** New seats are frozen (always-exclude → balanced pair-off only). Flag, suggest UX, auto-clear gate, quit synthetics, and calibrating display are unchanged.  
**Related:** `.cursor/rules/openskill-rating.mdc`, `src/services/rating/rating-update.ts`

## Goal

Keep New isolation when both teams bring matching New seats (pair them off so veterans rate without those high-σ entities), but **do not** freeze a lone / excess New when the other team has fewer non-quit New. Unequal New must participate in team `rate()` so one-sided New cannot silently turn a 6v6 into a 6v5 for veterans.

## Non-goals

- Soft dampening / contribution weights
- Schema flag for “frozen this match” (recompute from `wasNewPlayer` + slot + team)
- Changing suggest / confirm UX, `isNewPlayer` persistence, or auto-clear at ≥5 games
- Retroactive rewrite of past match payouts already applied under always-exclude
- Changing quitter or griefer rules beyond who counts toward New pair-off

## Locked decisions

| Topic                          | Choice                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| When freeze                    | **Pair-off only:** freeze `k = min(newA, newB)` paired seats per team (see `k` below)                                                                                          |
| Excess New                     | Non-quit New beyond paired `k` on the heavier team **rate** (full team `rate()` + lobby-relative Δμ scale)                                                                     |
| Which seats freeze             | Deterministic: **lowest slot numbers** pair first on each team; only **non-quit** seats in a pair freeze                                                                       |
| Quitters in `k`                | **Yes for pairing count** — all `wasNewPlayer` seats (quit or not) count toward `newA` / `newB` for `k`. Quitters stay on synthetic quit path only (never frozen via pair-off) |
| Equal counts (`1v1`, `2v2`, …) | All paired non-quit New freeze (same isolation as before for that subset)                                                                                                      |
| Unequal (`0v1`, `1v2`, …)      | `k` pairs freeze; excess rate. Example: one New on Evil only → `k=0` → that New rates                                                                                          |
| Degenerate skip                | Unchanged: after partition, if either team has 0 `activeRateable` → skip team `rate()`; quit synthetics still run                                                              |
| Snapshot                       | Still `MatchPlayer.wasNewPlayer` only; freeze vs rate is derived at apply/simulate/re-rate                                                                                     |
| Display                        | `· New` still from live flag / `wasNewPlayer`; Calibrating label unchanged; frozen New show no μ/σ delta; excess New may move while still labeled Calibrating if `games < 5`   |
| Approach storage               | Recompute in `partitionRosterForRating` (no new columns)                                                                                                                       |

## Rating partition

```text
quitters       = isQuitter
allNew(team)   = wasNewPlayer on that team (quit or not), sorted by slot
k              = min(|allNew team 1|, |allNew team 2|)
pairedNew      = k lowest-slot allNew on team 1 ∪ k lowest-slot allNew on team 2
frozenNew      = pairedNew ∩ nonQuitNew
excessNew      = nonQuitNew \ frozenNew
activeRateable = !isQuitter && not in frozenNew
                 // veterans + excess New (+ griefers who are not New/frozen)
newNonQuit     = frozenNew   // μ/σ freeze path (rename clarity optional in code)
```

Team Bayesian `rate()` runs on `activeRateable` only (then lobby-relative scale on those humans). Frozen New: no team `rate()` write, no lobby scale. Quitters (including New quitters): unchanged synthetic path.

## Edge cases

| Case                                | Rule                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 New vs 0 New, no quitters         | New rates; 6v6 (or whatever fill) with New included                                                                                         |
| 2 New on A, 1 on B                  | Freeze lowest-slot New on A + the one on B; remaining New on A rates                                                                        |
| 1v1 New                             | Both freeze; veterans rate without them                                                                                                     |
| All humans New, equal per side      | Everyone frozen → skip team `rate()`                                                                                                        |
| New quitter on A, New finisher on B | `k=1` (quitter counts for pairing); B’s New **freezes**; veterans stay 5v5                                                                  |
| New + griefer (non-quit)            | If excess → rates as griefer (no immediate μ/σ from grief tax path; still in team `rate()`). If frozen → freeze wins (not in team `rate()`) |
| Re-rate / flip                      | Recompute pair-off from `wasNewPlayer` + team + slot (same rule)                                                                            |

## Product note

Under always-exclude, New often saw five frozen games then first real `rate()` on game 6. With pair-off, **excess** New can receive real μ/σ updates earlier; frozen paired New still accrue the completed-game count toward the ≥5 clear without μ/σ change that match.

## Testing (acceptance)

- Unit: `k=0` (one-sided New) → that New in `activeRateable`, not frozen
- Unit: `1v1` New → both frozen; veterans rateable
- Unit: `2v1` New → lowest slot on heavy side + sole on light side frozen; leftover rateable
- Unit: New quitter counts toward `k` and keeps the paired surviving New frozen
- Unit: lowest-slot freeze order stable
- Regression: unmarked calibrating still always rateable; degenerate empty-side skip still works
- Simulate/apply: frozen New Δμ = 0; excess New Δμ can be non-zero

## Implementation touchpoints

- `src/services/rating/rating-update.ts` — `partitionRosterForRating` (+ callers assuming “all New = frozen”)
- Tests: `rating-update.test.ts`, `rating-update.simulate.test.ts`, `new-player.test.ts` as needed
- Docs: this spec; amend locked row in 2026-08-22 design; `.cursor/rules/openskill-rating.mdc` New-player isolation bullet
