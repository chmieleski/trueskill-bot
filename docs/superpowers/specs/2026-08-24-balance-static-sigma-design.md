# Balance static σ — Design

**Date:** 2026-08-24  
**Status:** Approved for test  
**Scope:** `general` (predictWin + lobby balance hints only; `rate()` unchanged)

## Goal

Decouple lobby win% and balance swap hints from per-player uncertainty (σ). Players accept σ-driven ki swings after matches; they should not see streak/calibration σ pull lobby balance toward 50/50.

## Decision

Per-league flag `League.balanceStaticSigmaEnabled` (default **false**):

- **Off:** current behavior — blended persisted σ in `ratingEntitiesForBalance`
- **On:** fixed `BALANCE_STATIC_SIGMA = 6.0` for every seat on the predictWin path; μ unchanged (80/20 blend when hero present)

Staff toggle: `/config set balance_static_sigma enabled:true|false`

## Non-goals

- Changing OpenSkill `rate()` or persisted σ
- Configurable σ value (fixed constant in code for v1)
- Persisting formula version on `Match` for immutable history win%
- Env vars / AWS SSM (DB column only)

## Architecture

```text
ratingEntitiesForOverall / ratingEntitiesForHero  → rate() (dynamic σ)
ratingEntitiesForBalance(options.staticSigma?)    → predictWin / balance hints
```

Call sites resolve `resolveLeagueConfig(leagueId).balanceStaticSigmaEnabled` and pass `{ staticSigma: true }` when enabled.

## Rollover

Successors inherit `balanceStaticSigmaEnabled` from the source league.

## Test plan (manual)

1. Enable on test league only; leave other leagues at default.
2. Compare lobby win% vs ki intuition and swap-hint trust during real lobbies.
3. Before official season: enable on live league if satisfied, or toggle off (zero apply-path impact).
