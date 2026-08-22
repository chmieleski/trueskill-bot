# Player vs hero weight for lobby balance — Design

**Date:** 2026-08-22  
**Status:** Approved (Approach 1 — predictWin / balance hints only)  
**Scope:** `general` (OpenSkill `predictWin` + lobby balance hints; keyed by `leagueId`)

## Goal

Lobby win chance and balance hints treat **player (league-global) skill as 80%** of a seat’s strength and **character (hero) skill as 20%**. Previously each filled UDBR slot added two equal OpenSkill entities, so player and hero counted 50/50 in `predictWin`.

## Non-goals

- Changing OpenSkill `rate()` / persisted `PlayerRating` or `PlayerHeroRating` μ/σ
- Merging the two rating tables into one μ
- Blending **display ki** (ki stays display-only; blend μ/σ)
- Retroactive recalculation of past matches
- ACA v1 (`heroId` null) — still global-only

## Decision

**Approach 1:** Blend only on the `predictWin` path (lobby embed win%, match-history win%, balance hints). Match apply, replay, and quitter synthetics keep `ratingEntitiesForPlayer` = `[global, hero]`.

```text
μ_eff = 0.8 × μ_player + 0.2 × μ_hero
σ_eff = √((0.8 × σ_player)² + (0.2 × σ_hero)²)
```

σ formula is the variance of a weighted sum of independent Gaussians.

## Architecture

```text
ratingEntitiesForPlayer     → rate() / quitter synthetics (unchanged dual entity)
ratingEntitiesForBalance    → predictWin / lobby-balance (one blended entity per hero slot)
```

| Call site                                           | Helper                     |
| --------------------------------------------------- | -------------------------- |
| `rating-update.ts` `buildTeamEntities` + synthetics | `ratingEntitiesForPlayer`  |
| `rating-preview.ts` `computeWinChanceFromRatings`   | `ratingEntitiesForBalance` |
| `lobby-balance.ts` `winChanceForRoster`             | `ratingEntitiesForBalance` |

Roster lines still show separate player ki and hero ki.

## Constants

`BALANCE_PLAYER_WEIGHT = 0.8`, `BALANCE_HERO_WEIGHT = 0.2` in `src/services/rating/rating-entities.ts`.
