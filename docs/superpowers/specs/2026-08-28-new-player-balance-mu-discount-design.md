# New-player balance μ discount — Design

**Date:** 2026-08-28  
**Status:** Implemented  
**Scope:** `general` (`predictWin` + lobby balance hints only; `rate()` unchanged)  
**Supersedes:** [`2026-08-28-new-player-balance-weight-design.md`](./2026-08-28-new-player-balance-weight-design.md) (merged here)  
**Related:** [`2026-08-26-balanced-new-player-isolation-design.md`](./2026-08-26-balanced-new-player-isolation-design.md), [`2026-08-22-new-player-rating-isolation-design.md`](./2026-08-22-new-player-rating-isolation-design.md), [`2026-08-24-balance-static-sigma-design.md`](./2026-08-24-balance-static-sigma-design.md)

## Problem

Flagged **New** seats still enter `predictWin` at **full blended μ** (~25 cold start). One-sided lobbies (e.g. 4 vet + 1 New vs 5 vet) look nearly fair in win% while a real newbie contributes ~**10%** of a ~2k vet.

New isolation already limits **rating apply** via balanced pair-off; win% and swap hints do not.

## Goal

On the **balance path only**, align win% with the same **paired New** rules as `rate()`:

- **Paired** New (matched across teams) → **no** team-strength contribution (omit from `predictWin`)
- **Excess / one-sided** New → **~10%** blended μ (tunable constant + cap)

No schema, env, or `rate()` changes.

## Locked decisions

| Topic                                    | Choice                                                                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path                                     | Balance only — `predictWin` / swap hints; `rate()` untouched                                                                                                                                             |
| Pair-off                                 | **Same math** as [`partitionRosterForRating`](../../src/services/rating/rating-update.ts) / [`2026-08-26-balanced-new-player-isolation-design.md`](./2026-08-26-balanced-new-player-isolation-design.md) |
| **Paired** New (frozen, non-quit)        | **Omit** from `predictWin` entity list                                                                                                                                                                   |
| **Excess** New (one-sided or beyond `k`) | `μ_eff = min(BALANCE_NEW_MU_WEIGHT × μ_blend, BALANCE_NEW_MU_CAP)`                                                                                                                                       |
| σ                                        | Unchanged; `balanceStaticSigmaEnabled` still applies to σ after blend                                                                                                                                    |
| Who counts as New                        | Live `isNewPlayer` (lobby) or snapshot `wasNewPlayer` (history)                                                                                                                                          |
| Unmarked calibrating                     | Full μ (unchanged)                                                                                                                                                                                       |
| Quitters (pre-match)                     | N/A — not seated as quitters before start                                                                                                                                                                |

## Paired New partition (must match rating apply)

Reuse the existing pair-off logic — extract to a shared helper (e.g. `new-player-partition.ts`) consumed by **`partitionRosterForRating`** and the balance path:

```text
allNew(team)   = wasNewPlayer / isNewPlayer on that team, sorted by slot (quitters count toward k on apply; pre-match all non-quit)
k              = min(|allNew team 1|, |allNew team 2|)
pairedNew      = k lowest-slot New on team 1 ∪ k lowest-slot New on team 2
frozenNew      = pairedNew ∩ nonQuit        # pre-match: pairedNew when no quitters yet
excessNew      = nonQuit New \ frozenNew
```

| Seat class             | Balance path                             |
| ---------------------- | ---------------------------------------- |
| Not New                | Full blended μ                           |
| **frozenNew** (paired) | **Omit** — no entity added to team array |
| **excessNew**          | Discounted μ (see below)                 |

Examples (mirror rating apply):

| Lobby New layout              | `k`        | Balance treatment                                              |
| ----------------------------- | ---------- | -------------------------------------------------------------- |
| 1 New team A only             | 0          | That New = **excess** → 10% μ                                  |
| 1 New each side               | 1          | Both **frozen** → **omit** both; win% = vet-only               |
| 2 New A, 1 New B              | 1          | Lowest on each side **omit**; A’s 2nd New = **excess** → 10% μ |
| All seats New, equal per side | all paired | All **omit** → undefined win% if both sides empty              |

## μ discount (excess New only)

After the existing 80/20 blend (or global-only for WOS):

```text
μ_blend = ratingEntitiesForBalance(...) as today

if seat ∈ frozenNew:
  omit

if seat ∈ excessNew:
  μ_eff = min(BALANCE_NEW_MU_WEIGHT × μ_blend, BALANCE_NEW_MU_CAP)
  σ_eff = σ_blend

else:
  μ_eff = μ_blend
```

### Constants (`rating-entities.ts`)

```typescript
/** Fraction of blended μ for excess / one-sided New in predictWin / balance hints. */
export const BALANCE_NEW_MU_WEIGHT = 0.1;

/** Ceiling so a mis-flagged high-μ vet cannot dominate win%. */
export const BALANCE_NEW_MU_CAP = 5;

export function effectiveBalanceMuForExcessNew(mu: number): number {
  return Math.min(mu * BALANCE_NEW_MU_WEIGHT, BALANCE_NEW_MU_CAP);
}
```

| Input μ_blend | ×0.1 | Cap 5   |
| ------------- | ---- | ------- |
| 25 (cold New) | 2.5  | 2.5     |
| 20 (~2k vet)  | 2.0  | 2.0     |
| 60 (extreme)  | 6.0  | **5.0** |

## Who is “New” for balance

| Context                                        | Flag                                |
| ---------------------------------------------- | ----------------------------------- |
| PENDING / in-progress lobby                    | `PlayerRating.isNewPlayer === true` |
| Completed match `/match show`                  | `MatchPlayer.wasNewPlayer === true` |
| Unmarked calibrating (`games < 5`, flag false) | **Full μ**                          |
| After `/player_new clear`                      | Full μ from next preview            |

## Non-goals

- Changing `rate()`, persisted μ/σ, or auto-clear at ≥5 games
- Per-league tunable weight (code constants; redeploy to tune)
- Discounting unmarked calibrating players
- DB / SSM / env vars
- Persisting formula version on `Match`

## Architecture

```text
new-player-partition.ts           → pair-off keys (shared with rating apply)
partitionRosterForRating          → rate() apply (refactor to import shared helper)
computeWinChanceFromRatings       → omit frozen, discount excess
lobby-balance winChanceForRoster  → same
loadLobbyRatingPreview            → isNewPlayer on entries
match-history-preview             → wasNewPlayer on entries
```

## Call-site checklist

| File                                               | Change                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `new-player-partition.ts` (new)                    | Export `classifyNewSeatsForBalance(entries)` → `{ frozenKeys, excessKeys }` (same `k` / lowest-slot rules as apply) |
| `rating-update.ts`                                 | Refactor `partitionRosterForRating` to use shared pair-off helper                                                   |
| `rating-entities.ts`                               | `BALANCE_NEW_MU_WEIGHT`, `BALANCE_NEW_MU_CAP`, `effectiveBalanceMuForExcessNew`                                     |
| `rating-preview.ts`                                | `computeWinChanceFromRatings`: classify seats, omit / discount                                                      |
| `lobby-balance.ts`                                 | Same classification in `winChanceForRoster`                                                                         |
| `match-history-preview.ts`                         | Pass `wasNewPlayer` into entries                                                                                    |
| `.cursor/rules/openskill-rating.mdc`               | Balance path: paired New omitted, excess discounted                                                                 |
| `2026-08-22-new-player-rating-isolation-design.md` | Close win-chance follow-up; link here                                                                               |

## Worked examples (μ_blend ≈ 20 vet, 25 New; weight 0.1)

| Lobby                                        | Today      | After                                               |
| -------------------------------------------- | ---------- | --------------------------------------------------- |
| 4 vet + 1 excess New vs 5 vet                | 105 vs 100 | **82.5 vs 100**                                     |
| 5 vet + 1 paired New vs 5 vet + 1 paired New | 125 vs 125 | **100 vs 100** (both New omitted)                   |
| 5 vet + 2 New vs 5 vet + 1 New               | 125 vs 125 | **102.5 vs 100** (one paired omit, one excess +2.5) |
| 5 vet vs 5 vet                               | 100 vs 100 | unchanged                                           |

## Edge cases

| Case                        | Behavior                                           |
| --------------------------- | -------------------------------------------------- |
| One-sided New only (`k=0`)  | All New are excess → 10% μ each                    |
| Equal New per side          | All paired → omit all; win% = vet-only matchup     |
| 2 New on A, 1 on B          | Pair lowest on each; A’s 2nd = excess              |
| All seats New, equal count  | All omit → **undefined** win%                      |
| New cleared mid-lobby       | Reclassify on next preview                         |
| WOS (`heroId` null)         | Same omit / discount on global entity              |
| `balanceStaticSigmaEnabled` | σ fixed after blend; omit/discount rules unchanged |

## Testing (acceptance)

- Unit: pair-off — `k=0` → excess only; `1v1` New → both frozen keys
- Unit: `effectiveBalanceMuForExcessNew(25) === 2.5`; cap at 60 → 5
- Unit: paired New omitted from entity list; excess returns discounted μ
- Unit: 4v5 one-sided New win% **< 45%** for short side
- Unit: 5+1 paired New vs 5+1 paired New → same win% as 5v5 vets
- Unit: unmarked calibrating → full μ
- Integration: `/player_new set` toggles win% and balance hints

## Tuning guide

1. Ship `BALANCE_NEW_MU_WEIGHT = 0.1`, `BALANCE_NEW_MU_CAP = 5`.
2. One-sided 4+New vs 5: target **~35–42%** for the short side.
3. Too generous → weight **0.05** or cap **3**; too harsh → **0.15** (avoid >0.2).

## Manual test plan

1. One-sided: `/player_new set` rookie on 4+New vs 5 → 5-stack favored.
2. Paired: 1 New each side + 5 vets → win% matches 5v5 vets (no +2.5 bump).
3. 2 New on one side, 1 on other → paired omit + one excess at 10%.
4. `/player_new clear` → full μ again.

## Product copy

Optional staff note: New marker affects lobby win% (paired omitted, excess ~10%), not only rating apply.
