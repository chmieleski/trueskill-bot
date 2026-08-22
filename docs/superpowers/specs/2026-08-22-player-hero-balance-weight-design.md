# Player vs hero weight for lobby balance — Design

**Date:** 2026-08-22  
**Status:** Approved (Approach 1 — predictWin / balance hints only)  
**Scope:** `general` (OpenSkill `predictWin` + lobby balance hints; keyed by `leagueId`)  
**Superseded for apply:** Dual-entity `rate()` / synthetics are replaced by [`2026-08-22-independent-overall-hero-rate-design.md`](./2026-08-22-independent-overall-hero-rate-design.md). This spec remains the source for **predictWin / balance hints only**.

## Goal

Lobby win chance and balance hints treat **player (league-global) skill as 80%** of a seat’s strength and **character (hero) skill as 20%**. Previously each filled UDBR slot added two equal OpenSkill entities, so player and hero counted 50/50 in `predictWin`.

## Non-goals

- Merging the two rating tables into one μ
- Blending **display ki** (ki stays display-only; blend μ/σ)
- Retroactive recalculation of past matches
- ACA v1 (`heroId` null) — still global-only
- Apply-path `rate()` (deferred here, then done in independent-overall-hero-rate)

## Decision

**Approach 1:** Blend only on the `predictWin` path (lobby embed win%, match-history win%, balance hints). Match apply, replay, and quitter synthetics use independent overall then hero `rate()` — see the independent-overall-hero-rate spec.

```text
μ_eff = 0.8 × μ_player + 0.2 × μ_hero
σ_eff = √((0.8 × σ_player)² + (0.2 × σ_hero)²)
```

σ formula is the variance of a weighted sum of independent Gaussians.

## Architecture

```text
ratingEntitiesForOverall     → overall rate() / overall synthetics
ratingEntitiesForHero        → hero rate() / hero synthetics
ratingEntitiesForBalance     → predictWin / lobby-balance (one blended entity per hero slot)
```

| Call site                                               | Helper                                               |
| ------------------------------------------------------- | ---------------------------------------------------- |
| `rating-update.ts` overall + hero `rate()` / synthetics | `ratingEntitiesForOverall` / `ratingEntitiesForHero` |
| `rating-preview.ts` `computeWinChanceFromRatings`       | `ratingEntitiesForBalance`                           |
| `lobby-balance.ts` `winChanceForRoster`                 | `ratingEntitiesForBalance`                           |

Roster lines still show separate player ki and hero ki.

## Constants

`BALANCE_PLAYER_WEIGHT = 0.8`, `BALANCE_HERO_WEIGHT = 0.2` in `src/services/rating/rating-entities.ts`.
