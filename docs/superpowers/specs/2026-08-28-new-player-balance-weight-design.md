# New-player balance weight — Design

**Date:** 2026-08-28  
**Status:** Superseded by [`2026-08-28-new-player-balance-mu-discount-design.md`](./2026-08-28-new-player-balance-mu-discount-design.md)  
**Scope:** `general` (`predictWin` + lobby balance hints only; `rate()` unchanged)

> **Note:** Pair-off omit + excess μ discount are merged into the superseding spec. Do not implement from this file.  
> **Related:** [`2026-08-26-balanced-new-player-isolation-design.md`](./2026-08-26-balanced-new-player-isolation-design.md), [`2026-08-22-new-player-rating-isolation-design.md`](./2026-08-22-new-player-rating-isolation-design.md), [`2026-08-24-balance-static-sigma-design.md`](./2026-08-24-balance-static-sigma-design.md), `.cursor/rules/openskill-rating.mdc`

## Problem

New isolation removes **frozen** New seats from team `rate()` so veterans are not dragged by high-σ newcomers. **`predictWin` and balance hints still count every human at full blended μ** (cold start μ ≈ 25, ~1000 display ki).

Players read **display ki** (~1000 Calibrating vs ~2000 vet ≈ “half a player”). The model often contributes **equal or higher raw μ** than a ~2k vet, so one-sided lobbies look far fairer than they are:

| Lobby                  | Team μ sums (all vets μ≈20, New μ=25) | Win% intuition                        |
| ---------------------- | ------------------------------------- | ------------------------------------- |
| 4 vet + 1 New vs 5 vet | 105 vs 100                            | Underdog side **slightly favored**    |
| Reality                | New ≈ **10%** of a 2k vet             | 5-stack should be **heavily** favored |

This closes the open follow-up from [`2026-08-22-new-player-rating-isolation-design.md`](./2026-08-22-new-player-rating-isolation-design.md): _Exclude New from win-chance / balance display_ — implemented as **weight down**, not hide, so asymmetric fills stay readable.

## Goal

Lobby **win%** and **balance swap hints** should treat New seats like the rating path does: **frozen paired New ≈ no team strength**; **excess / one-sided New ≈ small contribution** (~10% of a typical vet, not ~50–125%).

## Non-goals

- Changing OpenSkill `rate()`, persisted μ/σ, or New auto-clear at ≥5 games
- Discounting **unmarked calibrating** players (still full weight until staff/host marks New)
- Per-league tunable weight (fixed constant in code for v1)
- Persisting formula version on `Match` (same as static-σ: `/match show` win% reflects current code)
- Env vars / AWS SSM

## Locked decisions

| Topic                                                                        | Choice                                                                                                      |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Path                                                                         | **Balance only** — `ratingEntitiesForBalance` / callers; `rate()` untouched                                 |
| Who                                                                          | Seats with live `PlayerRating.isNewPlayer` (PENDING lobby) or snapshot `MatchPlayer.wasNewPlayer` (history) |
| Pair-off                                                                     | **Reuse** the same `k = min(newA, newB)` + lowest-slot pairing as `partitionRosterForRating`                |
| **Frozen** New (paired, non-quit)                                            | **Omit** from `predictWin` entity list (zero team-strength contribution)                                    |
| **Excess** New (non-quit, beyond `k` on heavier team, or all New when `k=0`) | **Discount** blended μ by `BALANCE_EXCESS_NEW_MU_WEIGHT` (default **0.1**)                                  |
| New + quitter                                                                | Quitters excluded from team `rate()` today; for **pre-match** balance, quitters are not seated yet — N/A    |
| σ                                                                            | Unchanged on discounted seats (only μ scaled); `staticSigma` league flag still applies after blend          |
| Unmarked calibrating                                                         | Full weight (unchanged)                                                                                     |
| Empty side after omit                                                        | If either team has **0** balance entities → `winChance` **undefined** (same as today)                       |

## Formula

```text
# Same pairing as rating apply (all wasNewPlayer on team count toward k; quitters N/A pre-match)
k           = min(|new team 1|, |new team 2|)
pairedNew   = k lowest-slot New per team
frozenNew   = pairedNew ∩ nonQuit   # pre-match: all New are non-quit
excessNew   = nonQuit New \ frozenNew

For each seated human in predictWin / balance hints:
  base = ratingEntitiesForBalance(global, hero, heroId, options)   # existing 80/20 + static σ

  if seat ∉ New:
    use base unchanged

  if seat ∈ frozenNew:
    omit (no entity added to team array)

  if seat ∈ excessNew:
    for each entity in base:
      μ' = BALANCE_EXCESS_NEW_MU_WEIGHT × μ
      σ' = σ   (unchanged)
```

Constants (in `rating-entities.ts` next to `BALANCE_PLAYER_WEIGHT`):

```text
BALANCE_EXCESS_NEW_MU_WEIGHT = 0.1   # ~10% of vet μ; tune after manual lobby testing
```

### Example (vets μ≈20, New defaults μ=25, 80/20 blend ≈25)

| Case                                      | predictWin entities                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| 5× vet vs 4× vet + 1 excess New           | 5× μ≈20 vs 4× μ≈20 + 1× μ≈**2.5**                                         |
| 5× vet + 1 New vs 5× vet + 1 New (paired) | 5× μ≈20 vs 5× μ≈20 (both New **omitted**)                                 |
| 5× vet + 2 New vs 5× vet + 1 New          | Side A: 5×20 + 1×**2.5** (one frozen omitted, one excess) vs Side B: 5×20 |

With `0.1` weight, one-sided New adds ~**12.5%** of default blended μ (2.5 vs 20) — close to the “10% of a 2k player” target.

## Architecture

```text
partitionRosterForRating (existing)     → rate() apply / simulate
partitionRosterForBalance (new)       → same k / frozen / excess split; read-only

computeWinChanceFromRatings           → pass isNew flags on entries; omit / discount
lobby-balance winChanceForRoster      → same via BalanceRosterEntry.isNewPlayer
loadLobbyRatingPreview                → already loads isNewPlayer; thread into winChance + suggestions
match-history winChanceFromSnapshots  → wasNewPlayer from MatchPlayer rows
```

Prefer extracting shared **pair-off math** from `rating-update.ts` into a small helper (e.g. `new-player-partition.ts`) used by both apply and balance paths — avoid duplicating lowest-slot / `k` logic.

## Call-site checklist

| File                                                                      | Change                                                                                       |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/services/rating/rating-entities.ts`                                  | `BALANCE_EXCESS_NEW_MU_WEIGHT`; optional `applyNewBalanceWeight(entity, role)`               |
| `src/services/rating/new-player-partition.ts` (new)                       | `partitionNewSeatsForBalance(entries)` → `{ frozenKeys, excessKeys }`                        |
| `src/services/rating/rating-preview.ts`                                   | `computeWinChanceFromRatings`: New-aware entity build; extend entry type with `isNewPlayer?` |
| `src/services/lobby/lobby-balance.ts`                                     | `BalanceRosterEntry.isNewPlayer?`; discount in `winChanceForRoster`                          |
| `src/services/rating/rating-preview.ts` `loadLobbyRatingPreview`          | Pass `isNewPlayer` into winChance + `suggestBalanceMoves` roster                             |
| `src/services/match/match-history-preview.ts`                             | Pass `wasNewPlayer` into `computeWinChanceFromRatings`                                       |
| `.cursor/rules/openskill-rating.mdc`                                      | New row under predictWin / balance                                                           |
| `docs/superpowers/specs/2026-08-22-new-player-rating-isolation-design.md` | Close follow-up; link here                                                                   |

## Edge cases

| Case                              | Rule                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One-sided New only (`k=0`)        | All New are excess → 10% μ each                                                                                                                                                                                     |
| Equal New per side                | All frozen → omit all; win% = vet-only matchup                                                                                                                                                                      |
| 2 New on A, 1 on B                | Freeze lowest on each team; A’s second New = excess (10%)                                                                                                                                                           |
| All seats New, equal count        | All frozen → 0 entities each side → **undefined** win%                                                                                                                                                              |
| All seats New, unequal            | Frozen on both + excess on heavy side                                                                                                                                                                               |
| Not flagged, 0 games, calibrating | Full μ (host declined suggest)                                                                                                                                                                                      |
| `/player_new clear` before match  | Live flag false → full weight in that lobby                                                                                                                                                                         |
| Completed match `/match show`     | Use `wasNewPlayer` snapshot so historical win% matches what lobby showed at apply time **if** snapshots were taken after seating; if win% is recomputed from snapshots only, pass `wasNewPlayer` from `MatchPlayer` |
| WOS (`heroId` null)               | Global-only entity; same omit / discount                                                                                                                                                                            |
| `balanceStaticSigmaEnabled`       | Apply static σ **after** μ discount on excess New                                                                                                                                                                   |

## Testing (acceptance)

- Unit: `k=0`, one excess New → μ contribution ×0.1 vs vet baseline
- Unit: `1v1` New paired → both omitted; 5v5 vets unchanged win%
- Unit: `4v5` one-sided New → win% favors 5-stack strongly (regression vs today’s ~105 vs 100)
- Unit: unmarked calibrating → unchanged full weight
- Unit: excess + static σ → σ = 6, μ discounted
- Integration: `loadLobbyRatingPreview` win% moves when `/player_new set` toggled
- Integration: `suggestBalanceMoves` no longer suggests swaps that “fix” a fake 4+New vs 5 imbalance

## Manual test plan

1. League with ~2k vets; seat one `/player_new set` rookie on the smaller team in a 4v5.
2. **Before:** win% near 50/50 or favors 4+New. **After:** clear favor to 5-stack.
3. Pair two New (1 each side) + vets: win% matches vet-only 5v5.
4. Toggle `balance_static_sigma` — discount still applies; σ fixed at 6 on excess New.

## v1 shortcut (optional)

If pair-off reuse is deferred: apply `μ × 0.1` to **every** `isNewPlayer` seat (no omit). Simpler; paired lobbies inflate both sides equally (+2.5 each) but stay ~50/50; one-sided case already much better. **Prefer full omit + excess** for consistency with rate().

## Product copy

No player-facing string changes required. Staff doc note (optional): New marker affects lobby win% weight, not just rating apply.
