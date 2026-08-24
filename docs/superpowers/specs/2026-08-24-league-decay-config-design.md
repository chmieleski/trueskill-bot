# League decay & crunch configuration — Design

**Date:** 2026-08-24  
**Status:** Approved for implementation  
**Scope:** `general` (per-league overrides for idle decay / crunch rates)  
**Related:** [`2026-08-23-rating-decay-design.md`](./2026-08-23-rating-decay-design.md)

## Goal

Allow staff to tune mid-season and crunch decay numbers **per league**, while keeping code defaults identical to v1.14 behavior when overrides are unset.

This supersedes the rating-decay v1 non-goal “Configurable per-league decay rates (fixed constants in code).”

## Approach

Nullable columns on `League`. `NULL` → code defaults from [`decay-settings.ts`](../../../src/services/rating/decay-settings.ts).

## Tunables

| Setting                     | Default           | Staff command                             |
| --------------------------- | ----------------- | ----------------------------------------- |
| Mid grace days              | 10                | `/config decay grace mode:mid`            |
| Mid tier1 / tier2 ki        | 50 / 100          | `/config decay tier1_ki` / `tier2_ki`     |
| Mid tier1 span              | 9                 | `/config decay tier1_span mode:mid`       |
| Mid streak cap              | 1000 (0 = none)   | `/config decay streak_cap`                |
| Crunch grace / tiers / span | 2 / 100 / 200 / 7 | same with `mode:crunch`                   |
| Crunch window days          | 7                 | `/config decay crunch_window`             |
| Prize lock                  | on                | `/config decay prize_lock`                |
| Prize lock min games        | 1                 | `/config decay prize_lock_min_games`      |
| Decay preset                | —                 | `/config decay preset name:strict_crunch` |

Master switch remains `/config set decay`. Season timing remains `/league set season_end` and `/league crunch`.

Discord forbids nested subcommand groups under `set`, so tuning lives in a top-level `/config decay` group. Clears use `/config decay clear_*`.

## Rollover

Successor leagues copy all override columns. Continue mode still forces `decayEnabled = false`.

## Non-goals

- Hero rating decay tuning
- Env / SSM keys
- Retroactive μ recalculation when settings change
