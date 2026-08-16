# Soft early ki (z-blend 3→2.5@5) — Design

**Date:** 2026-08-15  
**Status:** Implemented (as-built)  
**Scope:** `general` (display ki only; all leagues)

**Supersedes (display formula):** [`2026-08-13-ki-display-scale-design.md`](./2026-08-13-ki-display-scale-design.md) — OFFSET/SCALE unchanged; conservatism **z** is no longer fixed at 3.

## Goal

Public **ki** should keep true newcomers near **~1000**, while players with a few completed games usually sit **above** that floor unless they mostly lose — without changing OpenSkill `rate()` / `predictWin` or persisted μ/σ.

## Non-goals

- Lobby-blind “placement Elo” (asymmetric W/L ignoring opponents)
- Persisting a separate ki column
- Changing Prisma default μ/σ
- Returning z to 3 after the blend window (z **holds** at 2.5 for ≥5 games)
- Softening win-chance / balance math (still uses raw μ/σ)

## Locked decisions

| Topic | Choice |
|-------|--------|
| Formula | `ki = round(1000 + 200 × (μ − z·σ))` |
| z at 0 games | **3.0** (cold start ≈ 1000) |
| z after blend | **2.5** |
| Blend window | First **5** completed games; linear in game count |
| After window | Hold **z = 2.5** permanently |
| Global game count | Completed `MatchPlayer` rows with `result` WIN or LOSS in that league |
| Hero game count | `PlayerHeroRating.matchesPlayed` |
| OpenSkill updates | Unchanged |
| DTO names | Keep `*Ordinal`; values remain display ki |

## Math

```text
KI_OFFSET = 1000
KI_SCALE  = 200
KI_Z_START = 3
KI_Z_END = 2.5
KI_Z_BLEND_GAMES = 5

z(g) = 3                         if g ≤ 0
z(g) = 3 + (2.5 − 3) × (g / 5)   if 0 < g < 5
z(g) = 2.5                       if g ≥ 5

ki = round(1000 + 200 × (μ − z(g)·σ))
```

| Games g | z |
|--------:|--:|
| 0 | 3.0 |
| 1 | 2.9 |
| 2 | 2.8 |
| 3 | 2.7 |
| 4 | 2.6 |
| ≥5 | 2.5 |

### Illustrative display (live μ/σ at ship time; display-only)

| Profile | Approx | Old z=3 | New (blend) |
|---------|--------|--------:|------------:|
| New | 0–0, μ25 σ8.33 | 1000 | **1000** (g=0) |
| Soft 2–3 | ~μ23.6 σ8.1, g=5 | ~844 | **~1658** |
| Single loss | 0–1, high σ, g=1 | under 1000 | usually still ≤1000 |

## Architecture

```text
displayConservatismZ(matchesPlayed)
displayOrdinal(mu, sigma, matchesPlayed?)   // default matchesPlayed=0 → z=3

Call sites pass entity-specific game counts:
  overall / global ki  → completed W/L count for (leagueId, playerId)
  hero ki              → PlayerHeroRating.matchesPlayed
```

### Call sites (must pass game count)

| Surface | Module | Count source |
|---------|--------|--------------|
| Overall leaderboard / live board | `leaderboard.ts` | `matchPlayer.groupBy` completed W/L |
| Hero leaderboard | `leaderboard.ts` | `matchesPlayed` |
| `/rank` profile + competition rank | `player-profile.ts` | same groupBy for all league ratings; heroes use `matchesPlayed` |
| Lobby preview lines | `rating-preview.ts` | groupBy + hero `matchesPlayed` |
| Match complete before/after ki | `loadPlayerKiBySlot` | same (after complete, global count includes this match; hero +1 for non-quitters) |

## Edge cases

| Case | Behavior |
|------|----------|
| Missing rating row | Cold-start μ/σ with **g=0** → ~1000 |
| `displayOrdinal(mu, sigma)` omit g | Treated as **g=0** (z=3) — safe default for cold defaults only |
| Quitter | Global LOSS counts toward g once match is COMPLETED; hero `matchesPlayed` is **not** incremented on quit (existing update rule) → hero z may lag global |
| Dual entity | Global and hero **z** are independent |
| Ladder inflation | Veterans (≥5 games) permanently use z=2.5 → slightly higher public ki than pre-change at same μ/σ |
| After `/rank_reset` | Global g (and displayed W/L/quits) restart from matches with `completedAt` **after** the latest `PlayerRankReset`; default μ/σ → ~1000 until new games. Hero rows are deleted so hero g cold-starts. |

## Testing

- Unit: `displayConservatismZ` endpoints and midpoints; cold start 1000 at g=0; softened ki at g=5
- Call-site smoke: leaderboard / profile / preview still load (existing suite)
- Manual: lobby embed + `/rank` for a 0-game vs 5-game player

## Success criteria

- New players still show ~**1000**
- Typical few-game records are not stuck under 1000 solely due to z=3
- `rate()` / win% / balance unchanged
- One formula path: `rating-math.ts` only

## Out of scope / follow-ups

- Revisit permanent z=2.5 vs “placement-only then return to 3” if ladder stretch feels wrong
- Optional: increment hero `matchesPlayed` on quit for z parity (product choice)
- Historical plan/spec docs that still say “μ − 3σ” remain archival; **this file + `openskill-rating.mdc` are source of truth**
